import { Inject, Injectable } from "@nestjs/common";
import type { HandoverMethod } from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import type { DbHandle } from "../../db/client";
import type { DocumentKind } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { StoresService } from "../channel/stores.service";
import { OrderIntakeService } from "../orders/order-intake.service";
import { type ActionResult, OrdersService, orderStatusLabel } from "../orders/orders.service";
import { documentNotFound } from "./fulfillment.errors";
import { documentRequested, shipmentArrangeRequested, shipmentLabelRequested } from "./fulfillment.events";
import { type DocumentRow, FulfillmentRepository, type PackageRow, type ShipmentRow } from "./fulfillment.repository";
import { PickListBuilder, type PickListSection } from "./pick-list.builder";
import { arrangeRefusal } from "./shipping-plan";

export interface ShipmentView {
  shipment: ShipmentRow;
  packages: PackageRow[];
}

/**
 * Fulfillment for sellers (backend doc 8.15; PRD FR-SHP-01, 02, 06, FR-ORD-08, FR-WHS-08): arranging
 * pickup or drop-off through the worker, the shipments of orders, printable documents, and the pick
 * list. Reads respect the store and warehouse scope through OrdersService.
 */
@Injectable()
export class FulfillmentService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(FulfillmentRepository) private readonly repo: FulfillmentRepository,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(OrderIntakeService) private readonly intake: OrderIntakeService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(PickListBuilder) private readonly pickLists: PickListBuilder,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  /**
   * "Atur pengiriman" for many orders (FR-SHP-06): new orders are accepted on the way, then each store's
   * shipments and its request to the worker are written in one transaction. Results per order; the
   * marketplace's answer arrives on the shipment.
   */
  async arrange(ctx: RequestContext, orderIds: string[], method: HandoverMethod): Promise<ActionResult[]> {
    const ids = [...new Set(orderIds)];
    const visible = await this.orders.requireVisible(ctx, ids);
    const results = new Map<string, ActionResult>();
    const fresh = visible.filter((o) => o.status === "new").map((o) => o.id);
    if (fresh.length > 0) {
      for (const r of await this.orders.accept(ctx, fresh)) if (!r.ok) results.set(r.id, r);
    }
    const byStore = new Map<string, string[]>();
    for (const o of visible) {
      if (results.has(o.id)) continue;
      byStore.set(o.storeId, [...(byStore.get(o.storeId) ?? []), o.id]);
    }
    for (const [storeId, storeOrderIds] of byStore) {
      await withTenantTx(this.db, ctx, async (tx) => {
        const target = (await this.stores.stockTargetsIn(tx, [storeId])).get(storeId);
        const { orders } = await this.orders.readIn(tx, storeOrderIds);
        const live = await this.repo.liveFor(tx, storeOrderIds, true);
        const queued: string[] = [];
        for (const id of storeOrderIds) {
          const o = orders.find((x) => x.id === id);
          if (!o) {
            results.set(id, { id, ok: false, code: "order.not_found", message: "Pesanan tidak ditemukan." });
            continue;
          }
          const existing = live.find((s) => s.orderId === id) ?? null;
          const refusal = arrangeRefusal({
            status: o.status,
            statusLabel: orderStatusLabel(o.status),
            fulfillmentMode: o.fulfillmentMode,
            channel: o.channel,
            externalStatus: o.externalStatus,
            cancelRequested: o.cancelRequested,
            warehouseId: o.warehouseId,
            store: target ? { live: target.store.syncMode === "live", usable: target.usable } : null,
            shipment: existing ? { status: existing.status, lastError: existing.lastError } : null,
          });
          if (refusal) {
            results.set(id, { id, ok: false, ...refusal });
            continue;
          }
          let shipmentId = existing?.id;
          if (existing) {
            // a pending shipment whose last attempt failed: try again, maybe with the other method
            await this.repo.updateShipment(tx, existing.id, { pickupType: method, lastError: null });
          } else {
            const row = await this.repo.insertShipment(tx, {
              id: newId(),
              tenantId: ctx.tenantId,
              orderId: id,
              status: "pending",
              pickupType: method,
              provider: o.shippingProvider,
              service: o.shippingService,
            });
            if (!row) {
              results.set(id, {
                id,
                ok: false,
                code: "shipment.in_progress",
                message: "Pengiriman pesanan ini sedang diatur.",
              });
              continue;
            }
            shipmentId = row.id;
          }
          queued.push(shipmentId!);
          await this.intake.recordIn(tx, ctx, id, "shipment_requested", { type: "user", id: ctx.actor.id }, { method });
          results.set(id, { id, ok: true });
        }
        if (queued.length > 0) {
          await this.outbox.enqueue(
            tx,
            ctx,
            shipmentArrangeRequested,
            { storeId, shipmentIds: queued, method },
            storeId,
          );
        }
      });
    }
    return ids.map((id) => results.get(id)!);
  }

  /** Shipments of these orders with their packages, newest first (cancelled ones included). */
  async shipmentsOf(ctx: RequestContext, orderIds: string[]): Promise<ShipmentView[]> {
    await this.orders.requireVisible(ctx, orderIds);
    return withTenantTx(this.db, ctx, async (tx) => {
      const shipments = await this.repo.ofOrders(tx, [...new Set(orderIds)]);
      const packages = await this.repo.packages(
        tx,
        shipments.map((s) => s.id),
      );
      return shipments.map((s) => ({ shipment: s, packages: packages.filter((p) => p.shipmentId === s.id) }));
    });
  }

  /** Fetches the labels of arranged shipments again (after the automatic retries gave up). */
  async requestLabels(ctx: RequestContext, orderIds: string[]): Promise<number> {
    await this.orders.requireVisible(ctx, orderIds);
    return withTenantTx(this.db, ctx, async (tx) => {
      const shipments = (await this.repo.liveFor(tx, [...new Set(orderIds)])).filter((s) => s.status === "arranged");
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

  /** FR-SHP-01, 02: the worker renders the PDF; the caller polls the document (202). */
  async requestDocument(
    ctx: RequestContext,
    kind: DocumentKind,
    orderIds: string[],
    format: "thermal" | "a4",
  ): Promise<DocumentRow> {
    const ids = [...new Set(orderIds)];
    await this.orders.requireVisible(ctx, ids);
    return withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.insertDocument(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        kind,
        status: "queued",
        params: { orderIds: ids, ...(kind === "labels" ? { format } : {}) },
        requestedBy: ctx.actor.id,
      });
      await this.outbox.enqueue(tx, ctx, documentRequested, { documentId: row.id }, row.id);
      return row;
    });
  }

  /**
   * A document of this tenant. Users limited to some stores or warehouses see only their own requests:
   * someone else's document may hold orders outside their scope.
   */
  async document(ctx: RequestContext, id: string): Promise<DocumentRow> {
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.getDocument(tx, id));
    const scoped = ctx.storeScope !== null || ctx.warehouseScope !== null;
    if (!row || (scoped && row.requestedBy !== ctx.actor.id)) throw documentNotFound();
    return row;
  }

  /** The pick list as data, for the screen (L05); the PDF comes from a document. */
  async pickList(
    ctx: RequestContext,
    orderIds: string[],
  ): Promise<{ sections: PickListSection[]; missing: { orderId: string; code: string; message: string }[] }> {
    await this.orders.requireVisible(ctx, orderIds);
    return withTenantTx(this.db, ctx, (tx) => this.pickLists.buildIn(tx, [...new Set(orderIds)]));
  }

  // ---- full data export (FR-MIG-09) ----

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "pengiriman.csv",
        description: "Pengiriman pesanan: kurir, nomor resi, cara serah, dan waktu tiap tahap.",
        columns: [
          "no_pesanan",
          "toko",
          "status",
          "kurir",
          "layanan",
          "no_resi",
          "cara_serah",
          "jumlah_paket",
          "diatur_pada",
          "dikemas_pada",
          "diserahkan_pada",
          "diterima_pada",
          "gagal_pada",
          "alasan_gagal",
          "ongkir_aktual",
          "id_pesanan",
          "id",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.shipmentsPage(tx, after, EXPORT_PAGE_SIZE),
            async (rows) => {
              const refs = await this.orders.refsIn(
                tx,
                rows.map((s) => s.orderId),
              );
              return rows.map((s) => {
                const ref = refs.get(s.orderId);
                return [
                  ref?.externalOrderId,
                  l.storeName(ref?.storeId ?? null),
                  s.status,
                  s.provider,
                  s.service,
                  s.trackingNumber,
                  s.pickupType,
                  s.packageCount,
                  s.arrangedAt,
                  s.packedAt,
                  s.handedOverAt,
                  s.deliveredAt,
                  s.failedAt,
                  s.failedReason,
                  s.shippingCostActual,
                  s.orderId,
                  s.id,
                ];
              });
            },
          ),
      },
    ];
  }
}
