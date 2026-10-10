import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { toCsv } from "../../common/csv";
import { localDate, startOfDate } from "../../common/time-zone";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { TenantsService } from "../identity/tenants.service";
import { UsersService } from "../identity/users.service";
import { PACK_TIME_LIMIT_SECONDS } from "../orders/order-plan";
import { OrdersService } from "../orders/orders.service";
import { addDays } from "./sales-report-plan";
import { type StaffSection, staffCsvRows, staffReport } from "./staff-report-plan";

export interface StaffQuery {
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Team performance (PRD FR-RPT-10, UI L33, backend doc 8.35), from plan Growth on: what each user did to
 * orders in OmniSeller, per member and per day of the business's time zone, read from the order history
 * through OrdersService in the caller's store and warehouse scope. Owns no tables.
 */
@Injectable()
export class StaffReportService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  async report(ctx: RequestContext, q: StaffQuery, now = new Date()) {
    const timezone = await this.tenants.timezone(ctx);
    // this month so far unless asked otherwise, as the sales report
    const today = localDate(timezone, now);
    const range = { from: q.from ?? `${today.slice(0, 8)}01`, to: q.to ?? today };
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.tenants.requireFeatureIn(tx, ctx, "staff_report");
      const rows = await this.orders.staffActionsIn(
        tx,
        ctx,
        startOfDate(timezone, range.from),
        startOfDate(timezone, addDays(range.to, 1)),
        timezone,
      );
      return {
        timezone,
        range,
        packTimeLimitSeconds: PACK_TIME_LIMIT_SECONDS,
        ...staffReport(rows, await this.users.namesIn(tx)),
      };
    });
  }

  /** UI L33 "Unduh": per member, or per member per day. */
  async csv(ctx: RequestContext, q: StaffQuery, section: StaffSection): Promise<{ fileName: string; csv: string }> {
    const r = await this.report(ctx, q);
    return {
      fileName: `kinerja-tim-${section === "users" ? "per-anggota" : "per-hari"}-${r.range.from}-${r.range.to}.csv`,
      csv: toCsv(staffCsvRows(r, section), { timeZone: r.timezone }),
    };
  }
}
