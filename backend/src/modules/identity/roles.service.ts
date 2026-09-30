import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
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
}
