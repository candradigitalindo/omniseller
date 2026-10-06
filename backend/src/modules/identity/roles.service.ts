import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { IdentityRepository, type RoleRow } from "./identity.repository";

/** Built-in roles for now (PRD FR-USR-01 M); custom roles arrive in Fase 3. */
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

  /** Role names by id, in the caller's transaction (the audit log, backend doc 8.28). */
  async namesIn(tx: Tx): Promise<Map<string, string>> {
    return new Map((await this.repo.roleNames(tx)).map((r) => [r.id, r.name]));
  }

  /** What each permission allows by id ("Lihat log audit"), in the caller's transaction. */
  async permissionNamesIn(tx: Tx): Promise<Map<string, string>> {
    return new Map((await this.repo.permissionNames(tx)).map((p) => [p.id, p.name]));
  }
}
