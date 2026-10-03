import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { StoresService } from "../channel/stores.service";
import { UsersService } from "../identity/users.service";
import { type NewNotification, NotificationInboxService } from "../notification/inbox.service";
import { type SlaAlertLevel, slaAlertDue } from "./order-plan";
import { type OrderRow, OrdersRepository } from "./orders.repository";

/** Orders taken per scan; the rest waits for the next scan five minutes later. */
const BATCH = 500;

/**
 * Ship-by alerts (PRD FR-SHP-10): orders still to ship that crossed 6 hours left, or the deadline, since
 * the last scan. Each order is alerted once per level (`order.sla_alert_level`); people who arrange
 * shipments (`shipment:arrange`) get one notification per scan with the orders in their scope. Stores
 * in read-only mode are processed in the old application and are not alerted.
 */
@Injectable()
export class OrderAlertsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersRepository) private readonly repo: OrdersRepository,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  async alertDue(ctx: RequestContext, now = new Date()): Promise<{ orders: number; notified: number }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const due: { o: OrderRow; level: SlaAlertLevel }[] = [];
      for (const o of await this.repo.dueForAlert(tx, now, BATCH)) {
        const level = slaAlertDue(o.shipByAt, o.status, o.slaAlertLevel, now);
        if (!level) continue;
        await this.repo.update(tx, o.id, { slaAlertLevel: level });
        due.push({ o, level });
      }
      const stores = await this.stores.stockTargetsIn(tx, [...new Set(due.map((d) => d.o.storeId))]);
      const live = due.filter((d) => stores.get(d.o.storeId)?.store.syncMode === "live");
      if (live.length === 0) return { orders: due.length, notified: 0 };

      const notes: NewNotification[] = [];
      for (const r of await this.users.recipientsIn(tx, "shipment:arrange")) {
        const theirs = live.filter(
          (d) =>
            (r.storeScope === null || r.storeScope.includes(d.o.storeId)) &&
            (r.warehouseScope === null || (d.o.warehouseId !== null && r.warehouseScope.includes(d.o.warehouseId))),
        );
        if (theirs.length === 0) continue;
        const overdue = theirs.filter((d) => d.level === "overdue").length;
        const warning = theirs.length - overdue;
        notes.push({
          userId: r.id,
          kind: "order.sla",
          severity: overdue > 0 ? "critical" : "warning",
          title: `${theirs.length} pesanan harus segera dikirim`,
          body: `${[
            overdue > 0 ? `${overdue} sudah lewat batas kirim` : null,
            warning > 0 ? `${warning} jatuh tempo dalam 6 jam` : null,
          ]
            .filter(Boolean)
            .join(", ")}.`,
          data: { overdue, warning, orderIds: theirs.slice(0, 50).map((d) => d.o.id) },
        });
      }
      await this.inbox.notifyIn(tx, ctx, notes);
      return { orders: due.length, notified: notes.length };
    });
  }
}
