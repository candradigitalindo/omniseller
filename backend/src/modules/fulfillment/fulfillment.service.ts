import { Inject, Injectable } from "@nestjs/common";
import type { HandoverMethod } from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import type { DbHandle, Tx } from "../../db/client";
import type { DocumentKind, DocumentParams, StoredTrackingEvent, TrackingStage } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { isManualChannel, StoresService } from "../channel/stores.service";
import { FilesService } from "../files/files.service";
import { variantNotFound } from "../inventory/inventory.errors";
import { InventoryService } from "../inventory/inventory.service";
import { actorOf, OrderIntakeService } from "../orders/order-intake.service";
import { type ActionResult, OrdersService, orderStatusLabel } from "../orders/orders.service";
import { documentNotFound, trackingManual, trackingNotShipped } from "./fulfillment.errors";
import {
  documentRequested,
  shipmentArrangeRequested,
  shipmentLabelRequested,
  shipmentTrackingRequested,
} from "./fulfillment.events";
import { type DocumentRow, FulfillmentRepository, type PackageRow, type ShipmentRow } from "./fulfillment.repository";
import { PickListBuilder, type PickListSection } from "./pick-list.builder";
import type { PrintJobRow } from "./print.repository";
import { PrintService, type PrintTarget } from "./print.service";
import { printTitle } from "./scan-plan";
import {
  arrangeRefusal,
  type BarcodeLabelFormat,
  manualTrackingStage,
  TRACKED,
  TRACKING_REFRESH_MS,
} from "./shipping-plan";

export interface DocumentWithPrint {
  doc: DocumentRow;
  /** The newest job printing the document on a print agent (FR-SHP-17). */
  printJob: PrintJobRow | null;
}

export interface ShipmentView {
  shipment: ShipmentRow;
  packages: PackageRow[];
}

export interface TrackingView {
  orderId: string;
  /** marketplace: read from Shopee or TikTok Shop; manual: the order's own status, no courier tracking yet. */
  source: "marketplace" | "manual";
  trackingNumber: string | null;
  provider: string | null;
  stage: TrackingStage | null;
  events: StoredTrackingEvent[];
  syncedAt: Date | null;
  error: string | null;
  /** "Perbarui" can read it again. */
  refreshable: boolean;
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
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(PrintService) private readonly print: PrintService,
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
          await this.intake.recordIn(tx, ctx, id, "shipment_requested", actorOf(ctx), { method });
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

  /**
   * FR-SHP-01, 02, 03, 16: the worker renders the PDF; the caller polls the document (202). Labels take
   * the custom template and the packing lists when asked; packing lists alone take the format.
   */
  async requestDocument(
    ctx: RequestContext,
    kind: "labels" | "pick_list" | "packing_list",
    orderIds: string[],
    opts: { format: "thermal" | "a4"; template?: "standard" | "custom"; packingList?: boolean },
    print?: PrintTarget,
  ): Promise<DocumentWithPrint> {
    const ids = [...new Set(orderIds)];
    const orders = await this.orders.requireVisible(ctx, ids);
    const params: DocumentParams = {
      orderIds: ids,
      ...(kind === "labels"
        ? { format: opts.format, template: opts.template ?? "standard", packingList: opts.packingList ?? false }
        : kind === "packing_list"
          ? { format: opts.format }
          : {}),
    };
    return this.withPrint(ctx, print, (tx) => this.requestDocumentIn(tx, ctx, kind, params), {
      number: orders.length === 1 ? orders[0]!.externalOrderId : null,
    });
  }

  /** A document for the worker to render, in the caller's transaction (labels for a scan, manifests). */
  async requestDocumentIn(
    tx: Tx,
    ctx: RequestContext,
    kind: DocumentKind,
    params: DocumentParams,
  ): Promise<DocumentRow> {
    const row = await this.repo.insertDocument(tx, {
      id: newId(),
      tenantId: ctx.tenantId,
      kind,
      status: "queued",
      params,
      requestedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
    });
    await this.outbox.enqueue(tx, ctx, documentRequested, { documentId: row.id }, row.id);
    return row;
  }

  /**
   * The document, and with `print` a job sending it to a print agent once rendered (FR-SHP-17), in one
   * transaction.
   */
  private async withPrint(
    ctx: RequestContext,
    print: PrintTarget | undefined,
    make: (tx: Tx) => Promise<DocumentRow>,
    ref: { number?: string | null } = {},
  ): Promise<DocumentWithPrint> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const doc = await make(tx);
      const printJob = print
        ? await this.print.queueIn(tx, ctx, doc, print, printTitle(doc.kind, doc.params, ref))
        : null;
      return { doc, printJob };
    });
  }

  /**
   * Buyer data in the shipments of these orders goes (backend doc 8.34): tracking descriptions are emptied,
   * and labels and documents that print the buyer's address expire. In the caller's transaction, before the
   * orders themselves (module orders).
   */
  async anonymizeIn(tx: Tx, orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) return;
    const shipments = await this.repo.shipmentsOf(tx, orderIds);
    const packages = await this.repo.packages(
      tx,
      shipments.map((s) => s.id),
    );
    const files = [
      ...shipments.map((s) => s.labelFileId),
      ...packages.map((p) => p.labelFileId),
      ...(await this.repo.documentFilesFor(tx, orderIds)),
    ].filter((id): id is string => !!id);
    await this.files.expireIn(tx, files);
    await this.repo.clearTrackingDescriptions(
      tx,
      shipments.map((s) => s.id),
    );
  }

  /**
   * FR-INT-07, in the caller's transaction: the shipments of these orders go, with their packages; their
   * label files and every document that printed one of the orders expire now, since they carry buyer
   * data (the hourly file cleanup deletes them). Returns the shipments deleted.
   */
  async deleteForOrdersIn(tx: Tx, orderIds: string[]): Promise<number> {
    const shipments = await this.repo.shipmentsOf(tx, orderIds);
    const packages = await this.repo.packages(
      tx,
      shipments.map((s) => s.id),
    );
    const files = [
      ...shipments.map((s) => s.labelFileId),
      ...packages.map((p) => p.labelFileId),
      ...(await this.repo.documentFilesFor(tx, orderIds)),
    ].filter((id): id is string => !!id);
    await this.files.expireIn(tx, files);
    await this.repo.deleteShipments(
      tx,
      shipments.map((s) => s.id),
    );
    return shipments.length;
  }

  /**
   * FR-PRD-12: internal barcode labels of these variants, rendered by the worker like the other
   * documents, in the order given. Every variant must exist (archived ones too).
   */
  async requestBarcodeLabels(
    ctx: RequestContext,
    items: { variantId: string; copies: number }[],
    labelFormat: BarcodeLabelFormat,
    print?: PrintTarget,
  ): Promise<DocumentWithPrint> {
    return this.withPrint(ctx, print, async (tx) => {
      const found = await this.inventory.variantsIn(
        tx,
        items.map((i) => i.variantId),
      );
      const unknown = items.findIndex((i) => !found.has(i.variantId));
      if (unknown >= 0) throw variantNotFound(`items.${unknown}.variantId`);
      return this.requestDocumentIn(tx, ctx, "barcode_labels", { orderIds: [], items, labelFormat });
    });
  }

  /**
   * A document of this tenant. Users limited to some stores or warehouses see only their own requests:
   * someone else's document may hold orders outside their scope.
   */
  async document(ctx: RequestContext, id: string): Promise<DocumentWithPrint> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const doc = await this.repo.getDocument(tx, id);
      const scoped = ctx.storeScope !== null || ctx.warehouseScope !== null;
      if (!doc || (scoped && doc.requestedBy !== ctx.actor.id)) throw documentNotFound();
      return { doc, printJob: (await this.print.latestOfDocumentsIn(tx, [doc.id])).get(doc.id) ?? null };
    });
  }

  /**
   * L04 "Lacak" (FR-SHP-07): the order's parcel journey as last read from its marketplace. A manual order
   * shows the stage its own status implies; couriers' tracking needs an expedition integration.
   */
  async tracking(ctx: RequestContext, orderId: string): Promise<TrackingView> {
    const [o] = await this.orders.requireVisible(ctx, [orderId]);
    return withTenantTx(this.db, ctx, async (tx) => {
      const [s] = await this.repo.liveFor(tx, [orderId]);
      const manual = isManualChannel(o!.channel);
      return {
        orderId,
        source: manual ? "manual" : "marketplace",
        trackingNumber: s?.trackingNumber ?? o!.trackingNumber,
        provider: s?.provider ?? o!.shippingProvider,
        stage: manual ? manualTrackingStage(o!.status) : (s?.trackingStage ?? null),
        events: manual ? [] : (s?.trackingEvents ?? []),
        syncedAt: manual ? null : (s?.trackingSyncedAt ?? null),
        error: manual ? null : (s?.trackingError ?? null),
        refreshable: !manual && o!.fulfillmentMode === "seller" && TRACKED.has(o!.status),
      };
    });
  }

  /**
   * "Perbarui": the worker reads the parcel again (202). Nothing is queued when it was read in the last
   * 10 minutes; the answer says whether a read was queued.
   */
  async requestTracking(ctx: RequestContext, orderId: string): Promise<boolean> {
    const [o] = await this.orders.requireVisible(ctx, [orderId]);
    if (isManualChannel(o!.channel)) throw trackingManual();
    if (o!.fulfillmentMode !== "seller" || !TRACKED.has(o!.status)) throw trackingNotShipped();
    return withTenantTx(this.db, ctx, async (tx) => {
      const [s] = await this.repo.liveFor(tx, [orderId]);
      if (s?.trackingSyncedAt && Date.now() - s.trackingSyncedAt.getTime() < TRACKING_REFRESH_MS) return false;
      await this.outbox.enqueue(tx, ctx, shipmentTrackingRequested, { orderIds: [orderId] }, orderId);
      return true;
    });
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
