import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { DbHandle, Tx } from "../../db/client";
import {
  invitation,
  permission,
  plan,
  role,
  rolePermission,
  tenant,
  user,
  userRole,
  userStoreScope,
  userWarehouseScope,
  warehouse,
} from "../../db/schema";
import { DB_TENANT } from "../../infra/tokens";

export interface RoleRow {
  id: string;
  name: string;
  isSystem: boolean;
  description: string | null;
  permissions: string[];
  /** People holding it, disabled ones included. */
  userCount: number;
}

export interface UserView {
  id: string;
  name: string;
  email: string;
  status: "invited" | "active" | "disabled";
  locale: "id" | "en";
  roles: { id: string; name: string }[];
  storeIds: string[] | null;
  warehouseIds: string[] | null;
  lastLoginAt: Date | null;
  twoFactorEnabled: boolean;
  createdAt: Date;
  rowVersion: number;
}

export interface Principal {
  user: { id: string; name: string; email: string; locale: "id" | "en"; status: string; twoFactorEnabled: boolean };
  tenant: { id: string; name: string; slug: string; timezone: string; status: string };
  /** The plan in force (backend doc 8.32): its features decide what the web app offers. */
  plan: { code: string; name: string; features: string[] };
  permissions: string[];
  roles: { id: string; name: string }[];
  storeScope: string[] | null;
  warehouseScope: string[] | null;
}

/**
 * Aggregates used by several queries: roles, permissions, and scopes of a user as arrays.
 * Outer columns are written fully qualified on purpose: in a single-table select Drizzle renders
 * `${user.id}` as a bare "id", which inside these subqueries would bind to the joined table's id.
 */
const USER_ID = sql.raw(`"user"."id"`);
const ROLE_ID = sql.raw(`"role"."id"`);
const rolesOfUser = sql<{ id: string; name: string }[]>`coalesce((
    SELECT json_agg(json_build_object('id', r.id, 'name', r.name) ORDER BY r.name)
      FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ${USER_ID}), '[]'::json)`;
const storeScopeOfUser = sql<string[] | null>`(SELECT array_agg(s.store_id::text ORDER BY s.store_id)
    FROM user_store_scope s WHERE s.user_id = ${USER_ID})`;
const warehouseScopeOfUser = sql<string[] | null>`(SELECT array_agg(s.warehouse_id::text ORDER BY s.warehouse_id)
    FROM user_warehouse_scope s WHERE s.user_id = ${USER_ID})`;
const permissionsOfUser = sql<string[]>`coalesce((
    SELECT array_agg(DISTINCT p.code ORDER BY p.code) FROM user_role ur
      JOIN role_permission rp ON rp.role_id = ur.role_id
      JOIN permission p ON p.id = rp.permission_id
     WHERE ur.user_id = ${USER_ID}), '{}')`;
const permissionsOfRole = sql<string[]>`coalesce((
    SELECT array_agg(p.code ORDER BY p.code) FROM role_permission rp
      JOIN permission p ON p.id = rp.permission_id WHERE rp.role_id = ${ROLE_ID}), '{}')`;
const usersOfRole = sql<number>`(SELECT count(*)::int FROM user_role ur WHERE ur.role_id = ${ROLE_ID})`;

/**
 * Queries of the identity module (tenant, user, role, invitation). No business rules, no transactions:
 * every method receives the caller's tx (backend doc 8.4).
 */
@Injectable()
export class IdentityRepository {
  async planIdByCode(tx: Tx, code: string): Promise<string> {
    const [row] = await tx.select({ id: plan.id }).from(plan).where(eq(plan.code, code));
    if (!row) throw new Error(`plan ${code} missing; run db:migrate`);
    return row.id;
  }

  /** Every plan, cheapest first (PRD 14 "Model paket"; backend doc 8.32). */
  async listPlans(tx: Tx) {
    return tx.select().from(plan).orderBy(plan.priceMonthly, plan.code);
  }

  async insertTenant(tx: Tx, row: typeof tenant.$inferInsert): Promise<void> {
    await tx.insert(tenant).values(row);
  }

  /** The plan in force (`tenant.plan_id`), set by billing: trial, payment, lapse (backend doc 8.32). */
  async setTenantPlan(tx: Tx, id: string, planId: string): Promise<void> {
    await tx
      .update(tenant)
      .set({ planId, updatedAt: new Date(), rowVersion: sql`${tenant.rowVersion} + 1` })
      .where(and(eq(tenant.id, id), ne(tenant.planId, planId)));
  }

  /** The business name and time zone (the business profile, backend doc 8.29). */
  async updateTenant(tx: Tx, id: string, patch: { name?: string; timezone?: string }): Promise<void> {
    if (patch.name === undefined && patch.timezone === undefined) return;
    await tx
      .update(tenant)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${tenant.rowVersion} + 1` })
      .where(eq(tenant.id, id));
  }

  async getTenant(tx: Tx, id: string) {
    const [row] = await tx
      .select({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        timezone: tenant.timezone,
        planId: tenant.planId,
        createdAt: tenant.createdAt,
      })
      .from(tenant)
      .where(eq(tenant.id, id));
    return row;
  }

  /** Every role of the tenant: names for the audit log. */
  async roleNames(tx: Tx): Promise<{ id: string; name: string }[]> {
    return tx.select({ id: role.id, name: role.name }).from(role);
  }

  /** What each permission allows, in the seller's words ("Lihat log audit"). */
  async permissionNames(tx: Tx): Promise<{ id: string; name: string }[]> {
    const rows = await tx
      .select({ id: permission.id, code: permission.code, description: permission.description })
      .from(permission);
    return rows.map((p) => ({ id: p.id, name: p.description ?? p.code }));
  }

  async permissionIdsByCode(tx: Tx): Promise<Map<string, string>> {
    const rows = await tx.select({ id: permission.id, code: permission.code }).from(permission);
    return new Map(rows.map((r) => [r.code, r.id]));
  }

  async listPermissions(tx: Tx) {
    return tx
      .select({ code: permission.code, module: permission.module, description: permission.description })
      .from(permission)
      .orderBy(permission.code);
  }

  async insertRole(tx: Tx, row: typeof role.$inferInsert, permissionRows: (typeof rolePermission.$inferInsert)[]) {
    await tx.insert(role).values(row);
    if (permissionRows.length > 0) await tx.insert(rolePermission).values(permissionRows);
  }

  async listRoles(tx: Tx, ids?: string[]): Promise<RoleRow[]> {
    const rows = await tx
      .select({
        id: role.id,
        name: role.name,
        isSystem: role.isSystem,
        description: role.description,
        permissions: permissionsOfRole,
        userCount: usersOfRole,
      })
      .from(role)
      .where(ids ? inArray(role.id, ids) : undefined)
      .orderBy(role.name);
    return rows;
  }

  /** Locks a role for a change; undefined when it is not the caller's business's. */
  async lockRole(tx: Tx, id: string): Promise<{ id: string } | undefined> {
    const [row] = await tx.select({ id: role.id }).from(role).where(eq(role.id, id)).for("update");
    return row;
  }

  /** Whether another role of the business has this name, whatever its case. */
  async roleNameTaken(tx: Tx, name: string, exceptId?: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: role.id })
      .from(role)
      .where(and(sql`lower(${role.name}) = lower(${name})`, exceptId ? ne(role.id, exceptId) : undefined))
      .limit(1);
    return !!row;
  }

  async updateRole(tx: Tx, id: string, patch: { name?: string; description?: string | null }): Promise<void> {
    if (Object.keys(patch).length > 0) await tx.update(role).set(patch).where(eq(role.id, id));
  }

  /** Makes a role's permissions exactly these, touching only what changes (the audit log shows the change). */
  async setRolePermissions(tx: Tx, tenantId: string, roleId: string, permissionIds: string[], newId: () => string) {
    const held = await tx
      .select({ id: rolePermission.id, permissionId: rolePermission.permissionId })
      .from(rolePermission)
      .where(eq(rolePermission.roleId, roleId));
    const wanted = new Set(permissionIds);
    const gone = held.filter((h) => !wanted.has(h.permissionId)).map((h) => h.id);
    if (gone.length > 0) await tx.delete(rolePermission).where(inArray(rolePermission.id, gone));
    const have = new Set(held.map((h) => h.permissionId));
    const added = permissionIds.filter((p) => !have.has(p));
    if (added.length > 0) {
      await tx
        .insert(rolePermission)
        .values(added.map((permissionId) => ({ id: newId(), tenantId, roleId, permissionId })));
    }
  }

  /** Who still depends on a role: people holding it, and invitations not yet accepted or revoked. */
  async roleUsage(tx: Tx, id: string): Promise<{ users: number; invitations: number }> {
    const [u] = await tx.select({ n: sql<number>`count(*)::int` }).from(userRole).where(eq(userRole.roleId, id));
    const [i] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invitation)
      .where(and(eq(invitation.roleId, id), isNull(invitation.acceptedAt), isNull(invitation.revokedAt)));
    return { users: u?.n ?? 0, invitations: i?.n ?? 0 };
  }

  /** Its permissions go with it (CASCADE); closed invitations keep their row without it (SET NULL). */
  async deleteRole(tx: Tx, id: string): Promise<void> {
    await tx.delete(role).where(eq(role.id, id));
  }

  async userRoleIds(tx: Tx, userId: string): Promise<string[]> {
    const rows = await tx.select({ roleId: userRole.roleId }).from(userRole).where(eq(userRole.userId, userId));
    return rows.map((r) => r.roleId);
  }

  async roleByName(tx: Tx, name: string) {
    const [row] = await tx.select({ id: role.id, name: role.name }).from(role).where(eq(role.name, name));
    return row;
  }

  async insertUser(tx: Tx, row: typeof user.$inferInsert): Promise<void> {
    await tx.insert(user).values(row);
  }

  async userIdByEmail(tx: Tx, email: string): Promise<string | undefined> {
    const [row] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email));
    return row?.id;
  }

  async getUserSecret(tx: Tx, id: string) {
    const [row] = await tx
      .select({ id: user.id, passwordHash: user.passwordHash, status: user.status, email: user.email, name: user.name })
      .from(user)
      .where(eq(user.id, id));
    return row;
  }

  private userViewQuery(tx: Tx) {
    return tx
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        status: user.status,
        locale: user.locale,
        roles: rolesOfUser,
        storeIds: storeScopeOfUser,
        warehouseIds: warehouseScopeOfUser,
        lastLoginAt: user.lastLoginAt,
        twoFactorEnabled: user.totpEnabled,
        createdAt: user.createdAt,
        rowVersion: user.rowVersion,
      })
      .from(user);
  }

  async getUserView(tx: Tx, id: string): Promise<UserView | undefined> {
    const [row] = await this.userViewQuery(tx).where(eq(user.id, id));
    return row;
  }

  /** Newest first; fetches limit + 1 so the caller can tell whether there is a next page. */
  async listUserViews(tx: Tx, beforeId: string | undefined, limit: number): Promise<UserView[]> {
    return this.userViewQuery(tx)
      .where(beforeId ? lt(user.id, beforeId) : undefined)
      .orderBy(desc(user.id))
      .limit(limit + 1);
  }

  async updateUser(
    tx: Tx,
    id: string,
    patch: Partial<typeof user.$inferInsert>,
    expectedRowVersion?: number,
  ): Promise<boolean> {
    const rows = await tx
      .update(user)
      .set(patch)
      .where(
        expectedRowVersion === undefined
          ? eq(user.id, id)
          : and(eq(user.id, id), eq(user.rowVersion, expectedRowVersion)),
      )
      .returning({ id: user.id });
    return rows.length === 1;
  }

  /**
   * A user's two-step verification (backend doc 8.30), with what checking a code needs. `lock` holds the
   * row until the transaction ends, so two requests cannot both use the same code.
   */
  async twoFactor(tx: Tx, id: string, lock = false) {
    const q = tx
      .select({
        id: user.id,
        email: user.email,
        status: user.status,
        passwordHash: user.passwordHash,
        lockedUntil: user.lockedUntil,
        totpEnabled: user.totpEnabled,
        totpEnabledAt: user.totpEnabledAt,
        totpSecretEnc: user.totpSecretEnc,
        totpLastStep: user.totpLastStep,
        backupCodes: user.totpBackupCodes,
      })
      .from(user)
      .where(eq(user.id, id));
    const [row] = lock ? await q.for("update") : await q;
    return row;
  }

  /** Uses up a backup code: true when the user had it. One statement, so a code works once. */
  async useBackupCode(tx: Tx, id: string, hash: string): Promise<boolean> {
    const rows = await tx
      .update(user)
      .set({ totpBackupCodes: sql`array_remove(${user.totpBackupCodes}, ${hash})` })
      .where(and(eq(user.id, id), sql`${hash} = ANY(${user.totpBackupCodes})`))
      .returning({ id: user.id });
    return rows.length === 1;
  }

  async lockUser(tx: Tx, id: string) {
    const [row] = await tx
      .select({ id: user.id, status: user.status, failedLoginCount: user.failedLoginCount })
      .from(user)
      .where(eq(user.id, id))
      .for("update");
    return row;
  }

  async setUserRoles(tx: Tx, tenantId: string, userId: string, roleIds: string[], newId: () => string) {
    await tx.delete(userRole).where(eq(userRole.userId, userId));
    if (roleIds.length > 0) {
      await tx.insert(userRole).values(roleIds.map((roleId) => ({ id: newId(), tenantId, userId, roleId })));
    }
  }

  async setUserScopes(
    tx: Tx,
    tenantId: string,
    userId: string,
    scopes: { storeIds?: string[] | null; warehouseIds?: string[] | null },
    newId: () => string,
  ) {
    if (scopes.storeIds !== undefined) {
      await tx.delete(userStoreScope).where(eq(userStoreScope.userId, userId));
      if (scopes.storeIds?.length) {
        await tx
          .insert(userStoreScope)
          .values(scopes.storeIds.map((storeId) => ({ id: newId(), tenantId, userId, storeId })));
      }
    }
    if (scopes.warehouseIds !== undefined) {
      await tx.delete(userWarehouseScope).where(eq(userWarehouseScope.userId, userId));
      if (scopes.warehouseIds?.length) {
        await tx
          .insert(userWarehouseScope)
          .values(scopes.warehouseIds.map((warehouseId) => ({ id: newId(), tenantId, userId, warehouseId })));
      }
    }
  }

  /** Active users holding the Owner role, optionally ignoring one user. */
  async countActiveOwners(tx: Tx, exceptUserId?: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(DISTINCT ${user.id})::int` })
      .from(user)
      .innerJoin(userRole, eq(userRole.userId, user.id))
      .innerJoin(role, eq(role.id, userRole.roleId))
      .where(
        and(
          eq(role.name, "Owner"),
          eq(role.isSystem, true),
          eq(user.status, "active"),
          exceptUserId ? ne(user.id, exceptUserId) : undefined,
        ),
      );
    return row?.n ?? 0;
  }

  /** Every user of the tenant, disabled ones included. */
  async userNames(tx: Tx): Promise<{ id: string; name: string }[]> {
    return tx.select({ id: user.id, name: user.name }).from(user);
  }

  /** Seats in use against the plan (backend doc 8.32): users not disabled, plus invitations still open. */
  async countSeats(tx: Tx): Promise<number> {
    const [u] = await tx.select({ n: sql<number>`count(*)::int` }).from(user).where(ne(user.status, "disabled"));
    const [i] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invitation)
      .where(and(isNull(invitation.acceptedAt), isNull(invitation.revokedAt), gt(invitation.expiresAt, new Date())));
    return (u?.n ?? 0) + (i?.n ?? 0);
  }

  /** Who a subscription invoice is addressed to: the longest-standing active holder of settings:billing. */
  async billingContact(tx: Tx): Promise<{ email: string; name: string } | undefined> {
    const [row] = await tx
      .select({ email: user.email, name: user.name })
      .from(user)
      .where(and(eq(user.status, "active"), sql`'settings:billing' = ANY(${permissionsOfUser})`))
      .orderBy(user.id)
      .limit(1);
    return row;
  }

  /** Active users holding a permission, with their store and warehouse scopes (recipients of alerts). */
  async usersWithPermission(
    tx: Tx,
    permission: string,
  ): Promise<{ id: string; storeScope: string[] | null; warehouseScope: string[] | null }[]> {
    return tx
      .select({ id: user.id, storeScope: storeScopeOfUser, warehouseScope: warehouseScopeOfUser })
      .from(user)
      .where(and(eq(user.status, "active"), sql`${permission} = ANY(${permissionsOfUser})`))
      .orderBy(user.id);
  }

  async loadPrincipal(tx: Tx, userId: string): Promise<Principal | undefined> {
    const [row] = await tx
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        locale: user.locale,
        status: user.status,
        twoFactorEnabled: user.totpEnabled,
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        tenantTimezone: tenant.timezone,
        tenantStatus: tenant.status,
        planCode: plan.code,
        planName: plan.name,
        planFeatures: plan.features,
        roles: rolesOfUser,
        permissions: permissionsOfUser,
        storeScope: storeScopeOfUser,
        warehouseScope: warehouseScopeOfUser,
      })
      .from(user)
      .innerJoin(tenant, eq(tenant.id, user.tenantId))
      .innerJoin(plan, eq(plan.id, tenant.planId))
      .where(eq(user.id, userId));
    if (!row) return undefined;
    return {
      user: {
        id: row.userId,
        name: row.name,
        email: row.email,
        locale: row.locale,
        status: row.status,
        twoFactorEnabled: row.twoFactorEnabled,
      },
      tenant: {
        id: row.tenantId,
        name: row.tenantName,
        slug: row.tenantSlug,
        timezone: row.tenantTimezone,
        status: row.tenantStatus,
      },
      plan: { code: row.planCode, name: row.planName, features: row.planFeatures },
      permissions: row.permissions,
      roles: row.roles,
      storeScope: row.storeScope,
      warehouseScope: row.warehouseScope,
    };
  }

  async insertWarehouse(tx: Tx, row: typeof warehouse.$inferInsert): Promise<void> {
    await tx.insert(warehouse).values(row);
  }

  // ---- invitations ----

  async insertInvitation(tx: Tx, row: typeof invitation.$inferInsert): Promise<void> {
    await tx.insert(invitation).values(row);
  }

  private invitationQuery(tx: Tx) {
    return tx
      .select({
        id: invitation.id,
        email: invitation.email,
        // the role's own id: the inner join leaves out invitations whose custom role was deleted
        roleId: role.id,
        roleName: role.name,
        invitedBy: invitation.invitedBy,
        expiresAt: invitation.expiresAt,
        sentAt: invitation.sentAt,
        acceptedAt: invitation.acceptedAt,
        revokedAt: invitation.revokedAt,
        createdAt: invitation.createdAt,
      })
      .from(invitation)
      .innerJoin(role, eq(role.id, invitation.roleId));
  }

  async getInvitation(tx: Tx, id: string, forUpdate = false) {
    const q = this.invitationQuery(tx).where(eq(invitation.id, id));
    const [row] = forUpdate ? await q.for("update", { of: invitation }) : await q;
    return row;
  }

  async openInvitationByEmail(tx: Tx, email: string) {
    const [row] = await tx
      .select({ id: invitation.id })
      .from(invitation)
      .where(and(eq(invitation.email, email), isNull(invitation.acceptedAt), isNull(invitation.revokedAt)));
    return row;
  }

  async listOpenInvitations(tx: Tx, beforeId: string | undefined, limit: number) {
    return this.invitationQuery(tx)
      .where(
        and(
          isNull(invitation.acceptedAt),
          isNull(invitation.revokedAt),
          beforeId ? lt(invitation.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(invitation.id))
      .limit(limit + 1);
  }

  async updateInvitation(tx: Tx, id: string, patch: Partial<typeof invitation.$inferInsert>): Promise<void> {
    await tx.update(invitation).set(patch).where(eq(invitation.id, id));
  }
}

/**
 * Lookups before the tenant is known (backend doc 7.5): thin wrappers over the SECURITY DEFINER
 * functions. The only reads allowed outside withTenantTx; each result carries the tenant id so the
 * caller continues inside withTenantTx.
 */
@Injectable()
export class PreTenantLookup {
  constructor(@Inject(DB_TENANT) private readonly db: DbHandle) {}

  async loginCandidates(email: string) {
    const r = await this.db.db.execute<{
      tenant_id: string;
      tenant_slug: string;
      tenant_name: string;
      tenant_status: string;
      user_id: string;
      user_status: string;
      password_hash: string;
      totp_enabled: boolean;
      failed_login_count: number;
      locked_until: string | null;
    }>(sql`SELECT * FROM auth_login_candidates(${email}) LIMIT 20`);
    return r.rows.map((row) => ({ ...row, locked_until: row.locked_until ? new Date(row.locked_until) : null }));
  }

  async invitation(tokenHash: string) {
    const r = await this.db.db.execute<{
      tenant_id: string;
      invitation_id: string;
      email: string;
      role_id: string;
      expires_at: string;
      accepted_at: string | null;
      revoked_at: string | null;
    }>(sql`SELECT * FROM auth_resolve_invitation(${tokenHash})`);
    const row = r.rows[0];
    return row && { ...row, expires_at: new Date(row.expires_at) };
  }

  async passwordReset(tokenHash: string) {
    const r = await this.db.db.execute<{
      tenant_id: string;
      token_id: string;
      user_id: string;
      expires_at: string;
      used_at: string | null;
    }>(sql`SELECT * FROM auth_resolve_password_reset(${tokenHash})`);
    const row = r.rows[0];
    return row && { ...row, expires_at: new Date(row.expires_at) };
  }

  /** A device by its token's hash, with its business's status (print agents, backend doc 8.24). */
  async device(tokenHash: string) {
    const r = await this.db.db.execute<{
      tenant_id: string;
      device_id: string;
      kind: "print_agent" | "mobile";
      warehouse_id: string | null;
      revoked_at: string | null;
      last_seen_at: string | null;
      tenant_status: "active" | "suspended" | "closing" | "closed";
    }>(sql`SELECT * FROM auth_resolve_device(${tokenHash})`);
    const row = r.rows[0];
    return row && { ...row, last_seen_at: row.last_seen_at ? new Date(row.last_seen_at) : null };
  }
}
