import { Inject, Injectable } from "@nestjs/common";
import {
  type ArrangeResult,
  type HandoverMethod,
  isConnectorError,
  type LabelResult,
  type NormalizedOrder,
  type PackageRef,
  type TrackingResult,
} from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import { newId, type OrderStatus } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withStatusSource, withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { isManualChannel, StoresService } from "../channel/stores.service";
import { FilesService } from "../files/files.service";
import { type Actor, OrderIntakeService } from "../orders/order-intake.service";
import { OrderSyncService } from "../orders/order-sync.service";
import type { OrderItemRow, OrderRow } from "../orders/orders.repository";
import { OrdersService } from "../orders/orders.service";
import { describeSyncError } from "../sync/connector-calls";
import { shipmentLabelRequested } from "./fulfillment.events";
import { FulfillmentRepository, type PackageRow, type ShipmentRow } from "./fulfillment.repository";
import { combineParcels, shipmentStepFor, TRACKED, TRACKING_REFRESH_MS } from "./shipping-plan";

const log = logger.forModule("fulfillment");

/** Shipping labels carry the buyer's name, phone, and address: kept 30 days, then deleted. */
export const LABEL_TTL_DAYS = 30;
const SYSTEM: Actor = { type: "system", id: null };
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

/** Labels that are not ready yet: thrown so BullMQ tries the job again later (backoff). */
export class LabelsPendingError extends Error {
  constructor(readonly pending: number) {
    super(`${pending} shipping label(s) not ready yet; trying again later`);
    this.name = "LabelsPendingError";
  }
}

interface Work {
  shipment: ShipmentRow;
  order: OrderRow;
}

/**
 * Worker side of fulfillment (backend doc 8.15): arranges shipments at the marketplace through
 * MarketplaceGateway, stores labels, and keeps shipments in line with their orders. Marketplace calls
 * happen outside database transactions; each result is written in its own short transaction.
 */
@Injectable()
export class FulfillmentWorkerService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(FulfillmentRepository) private readonly repo: FulfillmentRepository,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(OrderIntakeService) private readonly intake: OrderIntakeService,
    @Inject(OrderSyncService) private readonly orderSync: OrderSyncService,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(StoresService) private readonly stores: StoresService,
  ) {}

  /**
   * FR-SHP-07: where the parcels of these orders are, read from their marketplaces and kept on each
   * order's shipment. A marketplace order shipped without OmniSeller arranging it (Seller Center, parallel
   * mode) gets a shipment that holds its tracking. Manual orders, orders fulfilled by the marketplace,
   * orders of stores that are not connected, and parcels another job read in the last 10 minutes (since
   * the order's last status change) are left out.
   *
   * One background call per store, outside transactions: a store that fails does not stop the others,
   * and orders a store could not get to before a temporary failure stay as they were, for the next scan.
   */
  async pullTracking(ctx: RequestContext, orderIds: string[], queueJobId?: string): Promise<number> {
    const work = await withTenantTx(this.db, ctx, async (tx) => {
      const { orders } = await this.orders.readIn(tx, orderIds);
      const wanted = orders.filter(
        (o) => o.fulfillmentMode === "seller" && !isManualChannel(o.channel) && TRACKED.has(o.status),
      );
      const targets = await this.stores.stockTargetsIn(tx, [...new Set(wanted.map((o) => o.storeId))]);
      const usable = wanted.filter((o) => targets.get(o.storeId)?.usable);
      const live = await this.repo.liveFor(
        tx,
        usable.map((o) => o.id),
        true,
      );
      const rows: { order: OrderRow; shipment: ShipmentRow }[] = [];
      const recently = Date.now() - TRACKING_REFRESH_MS;
      for (const o of usable) {
        const known = live.find((s) => s.orderId === o.id);
        const read = known?.trackingSyncedAt?.getTime();
        // queued twice (a slow job and the next scan, or a scan and "Perbarui"): read once
        if (read !== undefined && read > recently && read >= o.statusChangedAt.getTime()) continue;
        const shipment =
          known ??
          (await this.repo.insertShipment(tx, {
            id: newId(),
            tenantId: ctx.tenantId,
            orderId: o.id,
            status: o.status === "delivered" || o.status === "completed" ? "delivered" : "in_transit",
            provider: o.shippingProvider,
            service: o.shippingService,
            trackingNumber: o.trackingNumber,
          }));
        if (shipment) rows.push({ order: o, shipment });
      }
      const packages = await this.repo.packages(
        tx,
        rows.map((r) => r.shipment.id),
      );
      return rows.map((r) => ({
        ...r,
        packageIds: packages
          .filter((p) => p.shipmentId === r.shipment.id && p.externalPackageId)
          .map((p) => p.externalPackageId!),
      }));
    });

    const results = new Map<string, TrackingResult>();
    for (const storeId of new Set(work.map((w) => w.order.storeId))) {
      const mine = work.filter((w) => w.order.storeId === storeId);
      try {
        const answer = await this.gateway.call(
          ctx,
          storeId,
          { kind: "tracking.pull", direction: "pull", ...(queueJobId ? { queueJobId } : {}) },
          (c, shop) =>
            c.fulfillment.tracking(
              shop,
              mine.map((w) => ({ externalOrderId: w.order.externalOrderId, externalPackageIds: w.packageIds })),
            ),
          (r) => ({ orders: mine.length, failed: r.filter((x) => "error" in x).length, left: mine.length - r.length }),
          { background: true },
        );
        for (const r of answer) {
          const w = mine.find((x) => x.order.externalOrderId === r.externalOrderId);
          if (w) results.set(w.order.id, r);
        }
      } catch (err) {
        log.warn({ err: describeSyncError(err), store_id: storeId }, "tracking pull failed for a store");
      }
    }

    await withTenantTx(this.db, ctx, async (tx) => {
      const now = new Date();
      for (const w of work) {
        const r = results.get(w.order.id);
        if (!r) continue;
        if ("error" in r) {
          await this.repo.updateShipment(tx, w.shipment.id, { trackingError: r.error.message, trackingSyncedAt: now });
          continue;
        }
        const t = combineParcels(r.parcels);
        await this.repo.updateShipment(tx, w.shipment.id, {
          trackingStage: t.stage,
          trackingEvents: t.events,
          trackingEventAt: t.eventAt,
          trackingSyncedAt: now,
          trackingError: null,
        });
      }
    });
    return results.size;
  }

  /**
   * FR-SHP-06: arranges the pending shipments of one store, reads the orders again (their packages and
   * the marketplace status after arranging), and asks for the labels of what was arranged.
   */
  async arrange(
    ctx: RequestContext,
    input: { storeId: string; shipmentIds: string[]; method: HandoverMethod },
    queueJobId?: string,
  ): Promise<{ arranged: number; failed: number }> {
    const work = await withTenantTx(this.db, ctx, async (tx) => {
      const shipments = (await this.repo.getMany(tx, input.shipmentIds)).filter((s) => s.status === "pending");
      const { orders } = await this.orders.readIn(
        tx,
        shipments.map((s) => s.orderId),
      );
      return shipments
        .map((s) => ({ shipment: s, order: orders.find((o) => o.id === s.orderId)! }))
        .filter((w): w is Work => !!w.order && w.order.storeId === input.storeId);
    });
    if (work.length === 0) return { arranged: 0, failed: 0 };
    const externalIds = work.map((w) => w.order.externalOrderId);
    const job = queueJobId ? { queueJobId } : {};

    let results: ArrangeResult[];
    try {
      results = await this.gateway.call(
        ctx,
        input.storeId,
        {
          kind: "shipments.arrange",
          direction: "push",
          request: { orders: externalIds.length, method: input.method },
          ...job,
        },
        (connector, shop) =>
          connector.fulfillment.arrange(shop, { externalOrderIds: externalIds, method: input.method }),
        (r) => ({ orders: r.length, arranged: r.filter((x) => x.packages.some((p) => p.ok)).length }),
      );
    } catch (err) {
      if (isConnectorError(err) && (err.kind === "transient" || err.kind === "auth_expired")) throw err;
      const { message } = describeSyncError(err);
      for (const w of work) {
        await withTenantTx(this.db, ctx, (tx) =>
          this.failIn(tx, ctx, w.shipment.id, w.order.id, { code: "arrange_failed", message }),
        );
      }
      if (!isConnectorError(err)) throw err;
      return { arranged: 0, failed: work.length };
    }

    // the orders as they are now: packages, tracking numbers, and PROCESSED / AWAITING_COLLECTION
    let snapshots: NormalizedOrder[] = [];
    try {
      snapshots = await this.gateway.call(
        ctx,
        input.storeId,
        { kind: "orders.refresh", direction: "pull", request: { orders: externalIds.length }, ...job },
        (connector, shop) => connector.orders.getOrders(shop, externalIds),
        (r) => ({ orders: r.length }),
      );
      await this.orderSync.ingest(ctx, input.storeId, snapshots, { source: "poll" });
    } catch (err) {
      // the arrangement stands; packages are taken from the arrange answer, the poll catches up
      log.warn({ err, store_id: input.storeId }, "order refresh after arranging failed");
    }

    let arranged = 0;
    let failed = 0;
    const forLabels: string[] = [];
    for (const w of work) {
      const result = results.find((r) => r.externalOrderId === w.order.externalOrderId);
      const snap = snapshots.find((s) => s.externalOrderId === w.order.externalOrderId);
      const outcome = await withTenantTx(this.db, ctx, (tx) =>
        this.applyArrangementIn(tx, ctx, w.shipment.id, result, snap, input.method),
      );
      if (outcome === "arranged") {
        arranged++;
        forLabels.push(w.shipment.id);
      } else if (outcome === "failed") failed++;
    }
    if (forLabels.length > 0) {
      await withTenantTx(this.db, ctx, (tx) =>
        this.outbox.enqueue(tx, ctx, shipmentLabelRequested, { shipmentIds: forLabels }, forLabels[0]!),
      );
    }
    log.info({ store_id: input.storeId, arranged, failed }, "shipments arranged");
    return { arranged, failed };
  }

  private async failIn(
    tx: Tx,
    ctx: RequestContext,
    shipmentId: string,
    orderId: string,
    error: { code: string; message: string },
  ): Promise<void> {
    const [s] = await this.repo.getMany(tx, [shipmentId], true);
    if (s?.status !== "pending") return;
    await this.repo.updateShipment(tx, shipmentId, { lastError: error.message });
    await this.intake.recordIn(tx, ctx, orderId, "shipment_failed", SYSTEM, error);
  }

  private packageItems(snapItems: { externalLineId: string; quantity: number }[], items: OrderItemRow[]) {
    return snapItems
      .map((i) => ({ orderItemId: items.find((it) => it.externalItemId === i.externalLineId)?.id, qty: i.quantity }))
      .filter((i): i is { orderItemId: string; qty: number } => !!i.orderItemId);
  }

  private async applyArrangementIn(
    tx: Tx,
    ctx: RequestContext,
    shipmentId: string,
    result: ArrangeResult | undefined,
    snap: NormalizedOrder | undefined,
    method: HandoverMethod,
  ): Promise<"arranged" | "failed" | "skipped"> {
    const [s] = await this.repo.getMany(tx, [shipmentId], true);
    if (s?.status !== "pending") return "skipped";
    if (!result || result.error) {
      const error = result?.error ?? { code: "no_result", message: "Marketplace tidak menjawab untuk pesanan ini." };
      await this.repo.updateShipment(tx, s.id, { lastError: error.message });
      await this.intake.recordIn(tx, ctx, s.orderId, "shipment_failed", SYSTEM, error);
      return "failed";
    }
    const ok = result.packages.filter((p) => p.ok);
    const refused = result.packages.filter((p) => !p.ok);
    const { items } = await this.orders.readIn(tx, [s.orderId]);
    const open = items.filter((i) => i.qty - i.cancelledQty > 0);
    const existing = await this.repo.packages(tx, [s.id]);
    for (const p of ok) {
      const snapPackage = snap?.packages.find((x) => x.externalPackageId === p.externalPackageId);
      let packageItems = this.packageItems(snapPackage?.items ?? [], items);
      // one package and no item list from the marketplace: the whole order
      if (packageItems.length === 0 && result.packages.length === 1) {
        packageItems = open.map((i) => ({ orderItemId: i.id, qty: i.qty - i.cancelledQty }));
      }
      const row = existing.find((e) => (e.externalPackageId ?? "") === p.externalPackageId);
      if (row) {
        await this.repo.updatePackage(tx, row.id, {
          trackingNumber: snapPackage?.trackingNumber ?? row.trackingNumber,
          ...(packageItems.length > 0 ? { items: packageItems } : {}),
        });
      } else {
        await this.repo.insertPackage(tx, {
          id: newId(),
          tenantId: ctx.tenantId,
          shipmentId: s.id,
          externalPackageId: p.externalPackageId || null,
          trackingNumber: snapPackage?.trackingNumber ?? null,
          items: packageItems,
        });
      }
    }
    if (ok.length === 0 || refused.length > 0) {
      const message =
        refused
          .map((p) => p.message)
          .filter(Boolean)
          .join(" ") || "Pengiriman tidak bisa diatur untuk pesanan ini.";
      await this.repo.updateShipment(tx, s.id, {
        lastError: ok.length > 0 ? `Sebagian paket gagal diatur: ${message}` : message,
      });
      await this.intake.recordIn(tx, ctx, s.orderId, "shipment_failed", SYSTEM, {
        code: refused[0]?.code ?? "arrange_failed",
        message,
      });
      return "failed";
    }
    const pickupAt = ok
      .map((p) => p.pickupAt)
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const provider =
      snap?.packages.find((x) => x.shippingProvider)?.shippingProvider ?? snap?.shippingProvider ?? s.provider;
    await this.repo.updateShipment(tx, s.id, {
      status: "arranged",
      arrangedAt: new Date(),
      lastError: null,
      packageCount: ok.length,
      provider,
      ...(pickupAt ? { pickupAt } : {}),
    });
    await this.intake.recordIn(tx, ctx, s.orderId, "shipment_arranged", SYSTEM, {
      method,
      packages: ok.length,
      ...(pickupAt ? { pickupAt: pickupAt.toISOString() } : {}),
      ...(ok.every((p) => p.alreadyArranged) ? { alreadyArranged: true } : {}),
    });
    return "arranged";
  }

  /**
   * Labels of arranged shipments: stored privately, then the shipment is label ready; an order already
   * packed becomes ready to ship. Labels the marketplace has not made yet make the job fail on purpose
   * so BullMQ tries again with backoff (LabelsPendingError).
   */
  async fetchLabels(
    ctx: RequestContext,
    shipmentIds: string[],
    queueJobId?: string,
  ): Promise<{ ready: number; pending: number }> {
    const loaded = await withTenantTx(this.db, ctx, async (tx) => {
      const shipments = (await this.repo.getMany(tx, shipmentIds)).filter((s) => s.status === "arranged");
      const packages = await this.repo.withoutLabel(
        tx,
        shipments.map((s) => s.id),
      );
      const { orders } = await this.orders.readIn(
        tx,
        shipments.map((s) => s.orderId),
      );
      return { shipments, packages, orders };
    });
    const byStore = new Map<string, { shipment: ShipmentRow; order: OrderRow; packages: PackageRow[] }[]>();
    for (const s of loaded.shipments) {
      const order = loaded.orders.find((o) => o.id === s.orderId);
      if (!order) continue;
      const list = byStore.get(order.storeId) ?? [];
      list.push({ shipment: s, order, packages: loaded.packages.filter((p) => p.shipmentId === s.id) });
      byStore.set(order.storeId, list);
    }

    let ready = 0;
    let pending = 0;
    for (const [storeId, entries] of byStore) {
      const refs: (PackageRef & { packageId: string; shipmentId: string })[] = entries.flatMap((e) =>
        e.packages.map((p) => ({
          externalOrderId: e.order.externalOrderId,
          externalPackageId: p.externalPackageId ?? "",
          packageId: p.id,
          shipmentId: e.shipment.id,
        })),
      );
      let labels: LabelResult[] = [];
      if (refs.length > 0) {
        try {
          labels = await this.gateway.call(
            ctx,
            storeId,
            {
              kind: "shipments.labels",
              direction: "pull",
              request: { packages: refs.length },
              ...(queueJobId ? { queueJobId } : {}),
            },
            (connector, shop) =>
              connector.fulfillment.labels(
                shop,
                refs.map((r) => ({ externalOrderId: r.externalOrderId, externalPackageId: r.externalPackageId })),
              ),
            (r) => ({
              ready: r.filter((l) => l.state === "ready").length,
              pending: r.filter((l) => l.state === "pending").length,
              failed: r.filter((l) => l.state === "failed").length,
            }),
          );
        } catch (err) {
          if (!isConnectorError(err) || err.kind !== "permanent") throw err;
          const { message } = describeSyncError(err);
          for (const e of entries) {
            await withTenantTx(this.db, ctx, (tx) =>
              this.repo.updateShipment(tx, e.shipment.id, { lastError: message }),
            );
          }
          continue;
        }
      }
      const refOf = new Map(refs.map((r) => [`${r.externalOrderId}|${r.externalPackageId}`, r]));
      for (const label of labels) {
        const ref = refOf.get(`${label.ref.externalOrderId}|${label.ref.externalPackageId}`);
        if (!ref) continue;
        if (label.state === "ready") {
          const file = await this.files.save(ctx, {
            purpose: "label",
            mime: "application/pdf",
            ext: "pdf",
            bytes: label.pdf,
            expiresAt: days(LABEL_TTL_DAYS),
          });
          await withTenantTx(this.db, ctx, (tx) =>
            this.repo.updatePackage(tx, ref.packageId, {
              labelFileId: file.id,
              ...(label.trackingNumber ? { trackingNumber: label.trackingNumber } : {}),
            }),
          );
          ready++;
        } else {
          if (label.state === "pending") pending++;
          await withTenantTx(this.db, ctx, (tx) =>
            this.repo.updateShipment(tx, ref.shipmentId, {
              lastError: label.message,
              ...(label.state === "pending" && label.trackingNumber ? { trackingNumber: label.trackingNumber } : {}),
            }),
          );
        }
      }
      for (const e of entries) await withTenantTx(this.db, ctx, (tx) => this.completeLabelsIn(tx, ctx, e.shipment.id));
    }
    if (pending > 0) throw new LabelsPendingError(pending);
    return { ready, pending };
  }

  /** Every package has its label: the shipment is label ready, and a packed order ready to ship. */
  private async completeLabelsIn(tx: Tx, ctx: RequestContext, shipmentId: string): Promise<void> {
    const [s] = await this.repo.getMany(tx, [shipmentId], true);
    if (s?.status !== "arranged") return;
    const packages = await this.repo.packages(tx, [s.id]);
    if (packages.length === 0 || packages.some((p) => !p.labelFileId)) return;
    const trackingNumber = packages.find((p) => p.trackingNumber)?.trackingNumber ?? s.trackingNumber;
    await this.repo.updateShipment(tx, s.id, { status: "label_ready", lastError: null, trackingNumber });
    await this.intake.setShippingIn(tx, s.orderId, { trackingNumber, shippingProvider: s.provider });
    await this.intake.recordIn(tx, ctx, s.orderId, "label_ready", SYSTEM, {
      ...(trackingNumber ? { trackingNumber } : {}),
      packages: packages.length,
    });
    const { orders } = await this.orders.readIn(tx, [s.orderId]);
    if (orders[0]?.status === "packed") await this.packIn(tx, ctx, s, orders[0], SYSTEM);
  }

  /** Packed order with its label ready: the shipment is packed and the order ready to ship. */
  private async packIn(tx: Tx, ctx: RequestContext, s: ShipmentRow, o: OrderRow, actor: Actor): Promise<void> {
    await this.repo.updateShipment(tx, s.id, {
      status: "packed",
      packedAt: new Date(),
      packedBy: actor.type === "user" ? actor.id : null,
    });
    await this.intake.advanceIn(tx, ctx, o.id, ["packed"], "ready_to_ship", actor, { reason: "label_ready" });
  }

  /** The order changed status: its shipment follows (doc 7.9, `shipmentStepFor`). */
  async followOrder(
    ctx: RequestContext,
    ev: { orderId: string; to: OrderStatus; actorType: Actor["type"]; actorId: string | null },
  ): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const [s] = await this.repo.liveFor(tx, [ev.orderId], true);
      if (!s) return;
      const step = shipmentStepFor(ev.to, s.status);
      if (!step) return;
      if (step.to === "packed") {
        const { orders } = await this.orders.readIn(tx, [ev.orderId]);
        if (orders[0]) await this.packIn(tx, ctx, s, orders[0], { type: ev.actorType, id: ev.actorId });
        return;
      }
      const write = () =>
        this.repo.updateShipment(tx, s.id, {
          status: step.to,
          ...(step.to === "delivered" ? { deliveredAt: new Date() } : {}),
        });
      if (step.via === "marketplace") await withStatusSource(tx, "marketplace", write);
      else await write();
    });
  }

  /** The marketplace says a tracking number or label is ready (Shopee push 4, 15): fetch the labels. */
  async labelsForOrders(ctx: RequestContext, storeId: string, externalOrderIds: string[]): Promise<number> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const ids = await this.orders.idsByExternalIn(tx, storeId, externalOrderIds);
      const shipments = (await this.repo.liveFor(tx, ids)).filter((s) => s.status === "arranged");
      if (shipments.length > 0) {
        await this.outbox.enqueue(
          tx,
          ctx,
          shipmentLabelRequested,
          { shipmentIds: shipments.map((s) => s.id) },
          shipments[0]!.id,
        );
      }
      return shipments.length;
    });
  }
}
