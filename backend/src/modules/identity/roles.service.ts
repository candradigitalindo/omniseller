import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { type ExportSheet, singlePage } from "../../common/export-sheet";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { customRoleNotFound, privilegeEscalation, roleInUse, roleNameTaken, systemRole } from "./identity.errors";
import { IdentityRepository, type RoleRow } from "./identity.repository";

export interface RoleInput {
  name: string;
  description?: string | null | undefined;
  permissions: string[];
}

export type RolePatch = Partial<RoleInput>;

/**
 * Roles (PRD FR-USR-01, backend doc 8.33): immutable built-in roles and custom roles available to every
 * tenant on every plan. Nobody gives permissions they do not hold: a custom role's permissions, before
 * and after a change, must all be the caller's. Roles and their assignments stay inside the tenant.
 */
@Injectable()
export class RolesService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(IdentityRepository) private readonly repo: IdentityRepository,
  ) {}

  async list(ctx: RequestContext): Promise<RoleRow[]> {
    return withTenantTx(this.db, ctx, (tx) => this.repo.listRoles(tx));
  }

  async permissions(ctx: RequestContext) {
    return withTenantTx(this.db, ctx, (tx) => this.repo.listPermissions(tx));
  }

  async create(ctx: RequestContext, input: RoleInput): Promise<RoleRow> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const permissions = [...new Set(input.permissions)];
      if (permissions.some((p) => !ctx.permissions.has(p))) throw privilegeEscalation();
      const name = input.name.trim();
      if (await this.repo.roleNameTaken(tx, name)) throw roleNameTaken();
      const ids = await this.repo.permissionIdsByCode(tx);
      const id = newId();
      await this.repo.insertRole(
        tx,
        { id, tenantId: ctx.tenantId, name, isSystem: false, description: input.description?.trim() || null },
        permissions.map((code) => ({ id: newId(), tenantId: ctx.tenantId, roleId: id, permissionId: ids.get(code)! })),
      );
      return (await this.repo.listRoles(tx, [id]))[0]!;
    });
  }

  async update(ctx: RequestContext, id: string, patch: RolePatch): Promise<RoleRow> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const current = await this.customRoleIn(tx, id);
      const permissions = patch.permissions ? [...new Set(patch.permissions)] : current.permissions;
      // what the role gives now and what it would give: the caller must hold both
      if ([...current.permissions, ...permissions].some((p) => !ctx.permissions.has(p))) throw privilegeEscalation();
      const name = patch.name?.trim();
      if (name !== undefined && (await this.repo.roleNameTaken(tx, name, id))) throw roleNameTaken();
      await this.repo.updateRole(tx, id, {
        ...(name !== undefined ? { name } : {}),
        ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
      });
      if (patch.permissions) {
        const ids = await this.repo.permissionIdsByCode(tx);
        await this.repo.setRolePermissions(
          tx,
          ctx.tenantId,
          id,
          permissions.map((code) => ids.get(code)!),
          newId,
        );
      }
      return (await this.repo.listRoles(tx, [id]))[0]!;
    });
  }

  /** On any plan, once nobody holds it and no open invitation offers it. */
  async remove(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const current = await this.customRoleIn(tx, id);
      if (current.permissions.some((p) => !ctx.permissions.has(p))) throw privilegeEscalation();
      const usage = await this.repo.roleUsage(tx, id);
      if (usage.users > 0 || usage.invitations > 0) throw roleInUse(usage);
      await this.repo.deleteRole(tx, id);
    });
  }

  /** Role names by id, in the caller's transaction (the audit log, backend doc 8.28). */
  async namesIn(tx: Tx): Promise<Map<string, string>> {
    return new Map((await this.repo.roleNames(tx)).map((r) => [r.id, r.name]));
  }

  /** What each permission allows by id ("Lihat log audit"), in the caller's transaction. */
  async permissionNamesIn(tx: Tx): Promise<Map<string, string>> {
    return new Map((await this.repo.permissionNames(tx)).map((p) => [p.id, p.name]));
  }

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "peran.csv",
        description: "Peran bawaan dan peran kustom: izin masing-masing dan jumlah pengguna yang memegangnya.",
        columns: ["nama", "jenis", "deskripsi", "izin", "jumlah_pengguna"],
        pages: (tx) =>
          singlePage(async () =>
            (await this.repo.listRoles(tx)).map((r) => [
              r.name,
              r.isSystem ? "bawaan" : "kustom",
              r.description,
              r.permissions.join(" "),
              r.userCount,
            ]),
          ),
      },
    ];
  }

  /** A custom role of the caller's business, locked for the change; built-in roles are refused. */
  private async customRoleIn(tx: Tx, id: string): Promise<RoleRow> {
    if (!(await this.repo.lockRole(tx, id))) throw customRoleNotFound();
    const current = (await this.repo.listRoles(tx, [id]))[0]!;
    if (current.isSystem) throw systemRole();
    return current;
  }
}
