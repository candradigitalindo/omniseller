import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { sql } from "drizzle-orm";
import { systemContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { FilesService } from "../files/files.service";
import { UsersService } from "../identity/users.service";
import { PURGE_BATCH, PURGE_BUDGET_MS } from "./retention-plan";

export type PurgeOutcome = "not_due" | "continued" | "done";

/**
 * Deletes a closed business (PRD 12.1, backend doc 8.36), worker only (job tenant.purge): from the first
 * run nobody signs in (status closed) and every session ends; the stored files go (`t/<id>/`), then every
 * table's rows in the order of `tenant_purge_order()`, a batch per statement, through SECURITY DEFINER
 * functions that refuse a business not closed and past its purge date. Invoices and subscriptions stay
 * (tax records), and so does the tenant row, renamed. A run stops after its time budget; the next scan
 * goes on. Logs counts only.
 */
@Injectable()
export class TenantPurgeService {
  private readonly log = logger.forModule("retention");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  async run(tenantId: string, budgetMs = PURGE_BUDGET_MS): Promise<PurgeOutcome> {
    const ctx = systemContext(tenantId);
    const started = Date.now();
    const due = await withTenantTx(this.db, ctx, async (tx) => {
      const r = await tx.execute<{ go: boolean }>(sql`SELECT begin_tenant_purge(${tenantId}) AS go`);
      return r.rows[0]?.go === true;
    });
    if (!due) return "not_due";

    // nobody signs in any more: every session ends, then the stored files go before their rows do
    const userIds = await withTenantTx(this.db, ctx, (tx) => this.users.idsIn(tx));
    await this.users.endSessions(tenantId, userIds);
    let files = await this.files.deleteAllObjects(tenantId);

    const tables = await withTenantTx(this.db, ctx, async (tx) => {
      const r = await tx.execute<{ table_name: string }>(
        sql`SELECT table_name FROM tenant_purge_order() ORDER BY depth, table_name`,
      );
      return r.rows.map((x) => x.table_name);
    });
    let rows = 0;
    for (const table of tables) {
      for (;;) {
        if (Date.now() - started > budgetMs) {
          this.log.info({ tenant_id: tenantId, rows, files, done: false }, "tenant purge continues");
          return "continued";
        }
        const n = await withTenantTx(this.db, ctx, async (tx) => {
          const r = await tx.execute<{ n: number }>(
            sql`SELECT purge_tenant_step(${tenantId}, ${table}, ${PURGE_BATCH}) AS n`,
          );
          return Number(r.rows[0]?.n ?? 0);
        });
        rows += n;
        if (n < PURGE_BATCH) break;
      }
    }
    // a job that stored a file while the rows went
    files += await this.files.deleteAllObjects(tenantId);
    const done = await withTenantTx(this.db, ctx, async (tx) => {
      const r = await tx.execute<{ done: boolean }>(sql`SELECT finish_tenant_purge(${tenantId}) AS done`);
      return r.rows[0]?.done === true;
    });
    this.log.info({ tenant_id: tenantId, rows, files, done }, "tenant purge");
    return done ? "done" : "continued";
  }
}
