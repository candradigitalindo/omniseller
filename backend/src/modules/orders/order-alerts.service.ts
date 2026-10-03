import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { StoresService } from "../channel/stores.service";
import { NotificationInboxService } from "../notification/inbox.service";
import { type SlaAlertLevel, slaAlertDue } from "./order-plan";
import { type OrderRow, OrdersRepository } from "./orders.repository";

/** Orders taken per scan; the rest waits for the next scan five minutes later. */
const BATCH = 500;
/** Statuses in which a new order still waits for the seller when its notification goes out. */
const STILL_NEW = new Set(["new", "problem"]);

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
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  /**
   * New orders since the last notification (PRD FR-NTF-01), one digest per person who processes orders
   * (`order:accept`) with the orders of their stores and warehouses. Orders handled before the digest
   * (accepted, cancelled) and stores in read-only mode are left out.
   */
  async notifyNewOrders(ctx: RequestContext): Promise<{ orders: number; notified: number }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const pending = await this.repo.pendingNewNotices(tx, BATCH);
      if (pending.length === 0) return { orders: 0, notified: 0 };
      await this.repo.clearNewNotices(
        tx,
        pending.map((o) => o.id),
      );
      const targets = await this.stores.stockTargetsIn(tx, [...new Set(pending.map((o) => o.storeId))]);
      const fresh = pending
        .filter((o) => STILL_NEW.has(o.status) && targets.get(o.storeId)?.store.syncMode === "live")
        .map((o) => ({ o, storeId: o.storeId, warehouseId: o.warehouseId }));
      const notified = await this.inbox.notifyScopedIn(tx, ctx, "order:accept", fresh, (theirs) => {
        const perStore = new Map<string, number>();
        for (const t of theirs) perStore.set(t.storeId, (perStore.get(t.storeId) ?? 0) + 1);
        const named = [...perStore].map(([id, n]) => `${targets.get(id)?.store.name ?? "Toko"} ${n}`);
        return {
          kind: "order.new",
          severity: "info",
          title: `${theirs.length} pesanan baru`,
          body: `${named.join(", ")}.`,
          data: {
            count: theirs.length,
            orderIds: theirs.slice(0, 50).map((t) => t.o.id),
            stores: [...perStore].map(([storeId, count]) => ({ storeId, count })),
          },
        };
      });
      return { orders: fresh.length, notified };
    });
  }

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
      const live = due
        .filter((d) => stores.get(d.o.storeId)?.store.syncMode === "live")
        .map((d) => ({ ...d, storeId: d.o.storeId, warehouseId: d.o.warehouseId }));
      const notified = await this.inbox.notifyScopedIn(tx, ctx, "shipment:arrange", live, (theirs) => {
        const overdue = theirs.filter((d) => d.level === "overdue").length;
        const warning = theirs.length - overdue;
        return {
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
        };
      });
      return { orders: due.length, notified };
    });
  }
}
