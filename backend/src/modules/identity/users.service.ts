import { Inject, Injectable } from "@nestjs/common";
import { newId, type Permission } from "@omniseller/shared";
import { type RequestContext, systemContext } from "../../common/context/request-context";
import { ConflictError } from "../../common/errors/domain-errors";
import { decodeCursor, page } from "../../common/http/pagination";
import { hashPassword, verifyPassword } from "../../common/security/password";
import type { SessionStore } from "../../common/security/session-store";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, SESSIONS } from "../../infra/tokens";
import {
  cannotDisableSelf,
  lastOwner,
  privilegeEscalation,
  roleNotFound,
  userNotFound,
  wrongCurrentPassword,
} from "./identity.errors";
import { IdentityRepository, type Principal, type UserView } from "./identity.repository";

/** Failed logins before the account is locked, and for how long (PRD 8.4, 12.3). */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(IdentityRepository) private readonly repo: IdentityRepository,
    @Inject(SESSIONS) private readonly sessions: SessionStore,
  ) {}

  /** Identity of a signed-in user, loaded on every authenticated request by the auth guard. */
  async loadPrincipal(tenantId: string, userId: string): Promise<Principal | undefined> {
    return withTenantTx(this.db, systemContext(tenantId), (tx) => this.repo.loadPrincipal(tx, userId));
  }

  /**
   * Who should hear about something that needs this permission (alerts, FR-SHP-10), with the scopes
   * that decide which stores and warehouses each of them may hear about.
   */
  async recipientsIn(
    tx: Tx,
    permission: Permission,
  ): Promise<{ id: string; storeScope: string[] | null; warehouseScope: string[] | null }[]> {
    return this.repo.usersWithPermission(tx, permission);
  }

  async list(ctx: RequestContext, cursor: string | undefined, limit: number) {
    const rows = await withTenantTx(this.db, ctx, (tx) => this.repo.listUserViews(tx, decodeCursor(cursor), limit));
    return page(rows, limit);
  }

  async get(ctx: RequestContext, id: string): Promise<UserView> {
    const view = await withTenantTx(this.db, ctx, (tx) => this.repo.getUserView(tx, id));
    if (!view) throw userNotFound();
    return view;
  }

  /** Name and status. Disabling signs the user out everywhere. `ifMatch` is the row_version (backend doc 8.8). */
  async update(
    ctx: RequestContext,
    id: string,
    patch: { name?: string | undefined; status?: "active" | "disabled" | undefined },
    ifMatch?: number,
  ): Promise<UserView> {
    const view = await withTenantTx(this.db, ctx, async (tx) => {
      const current = await this.repo.lockUser(tx, id);
      if (!current) throw userNotFound();
      if (patch.status === "disabled" && current.status !== "disabled") {
        if (id === ctx.actor.id) throw cannotDisableSelf();
        if ((await this.repo.countActiveOwners(tx, id)) === 0 && (await this.isOwner(tx, id))) throw lastOwner();
      }
      const changes: Record<string, unknown> = {};
      if (patch.name !== undefined) changes.name = patch.name;
      if (patch.status !== undefined) changes.status = patch.status;
      if (Object.keys(changes).length > 0) {
        const ok = await this.repo.updateUser(tx, id, changes, ifMatch);
        if (!ok) throw new ConflictError("row.stale", "Data sudah diubah orang lain. Muat ulang lalu coba lagi.");
      }
      return this.repo.getUserView(tx, id);
    });
    if (patch.status === "disabled") await this.sessions.revokeAll(ctx.tenantId, id);
    return view!;
  }

  /**
   * Replaces a user's roles. A user can only grant roles whose permissions they hold themselves,
   * and the tenant must keep at least one active Owner.
   */
  async setRoles(ctx: RequestContext, id: string, roleIds: string[]): Promise<UserView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      if (!(await this.repo.lockUser(tx, id))) throw userNotFound();
      const unique = [...new Set(roleIds)];
      const roles = await this.repo.listRoles(tx, unique);
      if (roles.length !== unique.length) throw roleNotFound();
      if (roles.some((r) => r.permissions.some((p) => !ctx.permissions.has(p)))) throw privilegeEscalation();
      const keepsOwner = roles.some((r) => r.isSystem && r.name === "Owner");
      if (!keepsOwner && (await this.isOwner(tx, id)) && (await this.repo.countActiveOwners(tx, id)) === 0) {
        throw lastOwner();
      }
      await this.repo.setUserRoles(tx, ctx.tenantId, id, unique, newId);
      return (await this.repo.getUserView(tx, id))!;
    });
  }

  /** Store and warehouse access (PRD FR-USR-02). null means every store or warehouse. */
  async setScopes(
    ctx: RequestContext,
    id: string,
    scopes: { storeIds?: string[] | null | undefined; warehouseIds?: string[] | null | undefined },
  ): Promise<UserView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      if (!(await this.repo.lockUser(tx, id))) throw userNotFound();
      await this.repo.setUserScopes(
        tx,
        ctx.tenantId,
        id,
        {
          storeIds: scopes.storeIds === undefined ? undefined : scopes.storeIds && [...new Set(scopes.storeIds)],
          warehouseIds:
            scopes.warehouseIds === undefined ? undefined : scopes.warehouseIds && [...new Set(scopes.warehouseIds)],
        },
        newId,
      );
      return (await this.repo.getUserView(tx, id))!;
    });
  }

  /** Changes the caller's own password and signs out every other session. */
  async changeOwnPassword(ctx: RequestContext, current: string, next: string, keepSessionToken?: string) {
    const secret = await withTenantTx(this.db, ctx, (tx) => this.repo.getUserSecret(tx, ctx.actor.id));
    if (!secret || !(await verifyPassword(secret.passwordHash, current))) throw wrongCurrentPassword();
    const hash = await hashPassword(next);
    await withTenantTx(this.db, ctx, (tx) => this.repo.updateUser(tx, ctx.actor.id, { passwordHash: hash }));
    await this.sessions.revokeAll(ctx.tenantId, ctx.actor.id, keepSessionToken);
  }

  // ---- used by the auth module (login and password reset); not exposed over HTTP ----

  async recordLoginSuccess(tenantId: string, userId: string, rehash?: string): Promise<void> {
    await withTenantTx(this.db, systemContext(tenantId), (tx) =>
      this.repo.updateUser(tx, userId, {
        lastLoginAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        ...(rehash ? { passwordHash: rehash } : {}),
      }),
    );
  }

  /** Counts a failed login; locks the account for LOCK_MINUTES after MAX_FAILED_LOGINS in a row. */
  async recordLoginFailure(tenantId: string, userId: string): Promise<{ locked: boolean }> {
    return withTenantTx(this.db, systemContext(tenantId), async (tx) => {
      const current = await this.repo.lockUser(tx, userId);
      if (!current) return { locked: false };
      const failed = current.failedLoginCount + 1;
      const locked = failed >= MAX_FAILED_LOGINS;
      await this.repo.updateUser(tx, userId, {
        failedLoginCount: locked ? 0 : failed,
        ...(locked ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } : {}),
      });
      return { locked };
    });
  }

  /** Sets a new password (reset flow), clears any lock, and signs the user out everywhere. */
  async resetPassword(tenantId: string, userId: string, passwordHash: string): Promise<void> {
    await withTenantTx(this.db, systemContext(tenantId), (tx) =>
      this.repo.updateUser(tx, userId, { passwordHash, failedLoginCount: 0, lockedUntil: null }),
    );
    await this.sessions.revokeAll(tenantId, userId);
  }

  private async isOwner(tx: Tx, userId: string): Promise<boolean> {
    const view = await this.repo.getUserView(tx, userId);
    return !!view?.roles.some((r) => r.name === "Owner");
  }
}
