import { Inject, Injectable } from "@nestjs/common";
import type { HandoverStatus } from "@omniseller/shared";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { nextDocumentNumber } from "../../common/document-number";
import { DomainError } from "../../common/errors/domain-errors";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import { localDate } from "../../common/time-zone";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { isManualChannel } from "../channel/stores.service";
import { TenantsService } from "../identity/tenants.service";
import { WarehousesService } from "../inventory/warehouses.service";
import { ManualOrdersService } from "../orders/manual-orders.service";
import { OrderIntakeService } from "../orders/order-intake.service";
import type { OrderRow } from "../orders/orders.repository";
import { OrdersService } from "../orders/orders.service";
import {
  handoverElsewhere,
  handoverEmpty,
  handoverItemNotFound,
  handoverItemsInvalid,
  handoverNotCompleted,
  handoverNotFound,
  handoverNotOpen,
  printWarehouseInvalid,
  scanRefused,
} from "./fulfillment.errors";
import { type DocumentRow, FulfillmentRepository, type ShipmentRow } from "./fulfillment.repository";
import { FulfillmentService } from "./fulfillment.service";
import { type HandoverItemRow, HandoverRepository, type HandoverRow } from "./handover.repository";
import type { PrintJobRow } from "./print.repository";
import { PrintService, type PrintTarget } from "./print.service";
import { ScanService } from "./scan.service";
import { type HandoverParcel, handoverNumber, handoverRefusal } from "./scan-plan";

/** Parcels counted per courier at most (L08's courier list). */
const AWAITING_LIMIT = 2_000;

export interface HandoverView {
  handover: HandoverRow;
  parcels: number;
}

export interface CompletedHandover extends HandoverView {
  document: DocumentRow;
  printJob: PrintJobRow | null;
}

const parcelOf = (o: OrderRow, s: ShipmentRow | undefined): HandoverParcel => ({
  manual: isManualChannel(o.channel),
  orderStatus: o.status,
  fulfillmentMode: o.fulfillmentMode,
  warehouseId: o.warehouseId,
  hasAddress: !!o.shippingAddress?.line1,
  shipmentStatus: s?.status ?? null,
  provider: s?.provider ?? o.shippingProvider,
});

/**
 * Courier handover (PRD FR-SHP-05, UI L08, backend doc 8.24). One open manifest per warehouse and
 * courier collects the parcels scanned at the dock (several stations fill the same one); each scan is
 * checked at once: packed with its label, from this warehouse, for this courier, not in another open
 * manifest. Completing the manifest checks every parcel again, hands the marketplace shipments over
 * (`handed_over`; the marketplace reports "shipped" when the courier scans them), ships the manual
 * orders, and renders the manifest with signature boxes, printed on an agent when asked.
 */
@Injectable()
export class HandoverService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(HandoverRepository) private readonly repo: HandoverRepository,
    @Inject(FulfillmentRepository) private readonly shipments: FulfillmentRepository,
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(ManualOrdersService) private readonly manual: ManualOrdersService,
    @Inject(OrderIntakeService) private readonly intake: OrderIntakeService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(ScanService) private readonly scanning: ScanService,
    @Inject(PrintService) private readonly print: PrintService,
  ) {}

  private visible(ctx: RequestContext, h: HandoverRow): boolean {
    return ctx.warehouseScope === null || ctx.warehouseScope.has(h.warehouseId);
  }

  private async getIn(tx: Tx, ctx: RequestContext, id: string, lock = false): Promise<HandoverRow> {
    const h = await this.repo.get(tx, id, lock);
    if (!h || !this.visible(ctx, h)) throw handoverNotFound();
    return h;
  }

  private async openIn(tx: Tx, ctx: RequestContext, id: string): Promise<HandoverRow> {
    const h = await this.getIn(tx, ctx, id, true);
    if (h.status !== "open") throw handoverNotOpen();
    return h;
  }

  /** A warehouse the caller may work in; a 422 on `warehouseId` otherwise. */
  private async warehouseIn(tx: Tx, ctx: RequestContext, id: string): Promise<void> {
    try {
      await this.warehouses.visibleOneIn(tx, ctx, id);
    } catch (err) {
      if (err instanceof DomainError && err.status === 404) throw printWarehouseInvalid();
      throw err;
    }
  }

  /** The open manifest of this warehouse and courier, opened now when there is none. */
  async open(ctx: RequestContext, input: { warehouseId: string; courier: string }): Promise<HandoverView> {
    const timezone = await this.tenants.timezone(ctx);
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.warehouseIn(tx, ctx, input.warehouseId);
      const existing = await this.repo.openFor(tx, input.warehouseId, input.courier);
      if (existing)
        return { handover: existing, parcels: (await this.repo.itemCounts(tx, [existing.id])).get(existing.id) ?? 0 };
      const period = localDate(timezone, new Date()).slice(2, 7).replace("-", "");
      const created = await this.repo.insert(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        number: handoverNumber(period, await nextDocumentNumber(tx, ctx.tenantId, "handover", period)),
        warehouseId: input.warehouseId,
        courier: input.courier,
        createdBy: ctx.actor.id,
      });
      // another station opened the same courier's manifest a moment ago: both scan into that one
      const h = created ?? (await this.repo.openFor(tx, input.warehouseId, input.courier))!;
      return { handover: h, parcels: created ? 0 : ((await this.repo.itemCounts(tx, [h.id])).get(h.id) ?? 0) };
    });
  }

  /**
   * L08's courier picker: couriers of the parcels in this warehouse that wait for one (packed with
   * their label, or manual orders packed), with how many each.
   */
  async couriers(ctx: RequestContext, warehouseId: string): Promise<{ courier: string | null; parcels: number }[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.warehouseIn(tx, ctx, warehouseId);
      const packed = await this.shipments.packedShipments(tx, AWAITING_LIMIT);
      const orders = await this.orders.visibleManyIn(
        tx,
        ctx,
        packed.map((s) => s.orderId),
      );
      const providers = [
        ...orders
          .filter((o) => o.warehouseId === warehouseId && o.fulfillmentMode === "seller")
          .map((o) => packed.find((s) => s.orderId === o.id)?.provider ?? o.shippingProvider),
        ...(await this.orders.manualAwaitingIn(tx, ctx, warehouseId, AWAITING_LIMIT)).map((o) => o.shippingProvider),
      ];
      const counts = new Map<string, { courier: string | null; parcels: number }>();
      for (const p of providers) {
        const key = p?.trim().toLowerCase() ?? "";
        const c = counts.get(key) ?? { courier: p?.trim() || null, parcels: 0 };
        c.parcels++;
        counts.set(key, c);
      }
      return [...counts.values()].sort((a, b) => b.parcels - a.parcels);
    });
  }

  /**
   * A scanned parcel joins the manifest. Scanning one already in it again changes nothing (`duplicate`);
   * one in another open manifest, or one that may not go (not packed, cancelled, another warehouse or
   * courier), is refused with the reason.
   */
  async scan(
    ctx: RequestContext,
    id: string,
    code: string,
  ): Promise<{ item: HandoverItemRow; parcels: number; duplicate: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const h = await this.openIn(tx, ctx, id);
      const found = await this.scanning.orderIn(tx, ctx, code);
      // the order's lock keeps two stations from putting it into two manifests at once
      const o = await this.orders.visibleIn(tx, ctx, found.id, true);
      const count = async () => (await this.repo.itemCounts(tx, [h.id])).get(h.id) ?? 0;
      const existing = await this.repo.itemOf(tx, h.id, o.id);
      if (existing) return { item: existing, parcels: await count(), duplicate: true };
      const elsewhere = await this.repo.openElsewhere(tx, o.id, h.id);
      if (elsewhere) throw handoverElsewhere(elsewhere.number);
      const [s] = await this.shipments.liveFor(tx, [o.id]);
      const why = handoverRefusal(parcelOf(o, s), h);
      if (why) throw scanRefused(why);
      const byOrderNumber = code.toUpperCase() === o.externalOrderId.toUpperCase();
      const item = await this.repo.insertItem(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        handoverId: h.id,
        orderId: o.id,
        shipmentId: s?.id ?? null,
        trackingNumber: byOrderNumber ? (s?.trackingNumber ?? o.trackingNumber ?? o.externalOrderId) : code,
        orderNumber: o.externalOrderId,
        scannedBy: ctx.actor.id,
      });
      return { item, parcels: await count(), duplicate: false };
    });
  }

  /** Takes a parcel scanned by mistake out of an open manifest. */
  async removeItem(ctx: RequestContext, id: string, itemId: string): Promise<HandoverView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const h = await this.openIn(tx, ctx, id);
      if (!(await this.repo.deleteItem(tx, h.id, itemId))) throw handoverItemNotFound();
      return { handover: h, parcels: (await this.repo.itemCounts(tx, [h.id])).get(h.id) ?? 0 };
    });
  }

  /**
   * "Selesaikan serah terima": every parcel is checked again (an order cancelled since its scan must not
   * leave), then marketplace shipments are handed over and manual orders shipped, all or nothing. The
   * manifest is rendered by the worker, and printed on an agent with `print`.
   */
  async complete(
    ctx: RequestContext,
    id: string,
    input: { receivedBy?: string | null | undefined; print?: PrintTarget | undefined },
  ): Promise<CompletedHandover> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const h = await this.openIn(tx, ctx, id);
      const items = await this.repo.items(tx, h.id);
      if (items.length === 0) throw handoverEmpty();
      // shipments before orders, the order the worker locks them in when a shipment follows its order
      const live = await this.shipments.liveFor(
        tx,
        items.map((i) => i.orderId),
        true,
      );
      const orders = await this.orders.lockIn(
        tx,
        items.map((i) => i.orderId),
      );
      const problems = items.flatMap((i) => {
        const o = orders.find((x) => x.id === i.orderId)!;
        const why = handoverRefusal(
          parcelOf(
            o,
            live.find((s) => s.orderId === o.id),
          ),
          h,
        );
        return why ? [{ itemId: i.id, trackingNumber: i.trackingNumber, ...why }] : [];
      });
      if (problems.length > 0) throw handoverItemsInvalid(problems);

      const now = new Date();
      const actor = { type: "user" as const, id: ctx.actor.id };
      const note = { handoverId: h.id, number: h.number, courier: h.courier };
      for (const i of items) {
        const o = orders.find((x) => x.id === i.orderId)!;
        if (isManualChannel(o.channel)) {
          await this.manual.shipIn(tx, ctx, o, {
            shippingProvider: o.shippingProvider ?? h.courier,
            trackingNumber: i.trackingNumber !== o.externalOrderId ? i.trackingNumber : undefined,
            payload: note,
          });
          continue;
        }
        const s = live.find((x) => x.orderId === o.id)!;
        await this.shipments.updateShipment(tx, s.id, {
          status: "handed_over",
          handedOverAt: now,
          handedOverBy: ctx.actor.id,
        });
        await this.intake.recordIn(tx, ctx, o.id, "handed_over", actor, {
          ...note,
          trackingNumber: i.trackingNumber,
        });
      }
      const done = await this.repo.update(tx, h.id, {
        status: "completed",
        completedAt: now,
        completedBy: ctx.actor.id,
        receivedBy: input.receivedBy?.trim() || null,
      });
      const made = await this.manifestIn(tx, ctx, done, input.print);
      return { handover: done, parcels: items.length, ...made };
    });
  }

  /** Cancels an open manifest; its parcels can be scanned into another one. */
  async cancel(ctx: RequestContext, id: string): Promise<HandoverView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const h = await this.openIn(tx, ctx, id);
      const done = await this.repo.update(tx, h.id, { status: "cancelled" });
      return { handover: done, parcels: (await this.repo.itemCounts(tx, [h.id])).get(h.id) ?? 0 };
    });
  }

  /** The manifest of a completed handover again (download or reprint). */
  async manifest(
    ctx: RequestContext,
    id: string,
    print?: PrintTarget,
  ): Promise<{ document: DocumentRow; printJob: PrintJobRow | null }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const h = await this.getIn(tx, ctx, id);
      if (h.status !== "completed") throw handoverNotCompleted();
      return this.manifestIn(tx, ctx, h, print);
    });
  }

  private async manifestIn(
    tx: Tx,
    ctx: RequestContext,
    h: HandoverRow,
    print: PrintTarget | undefined,
  ): Promise<{ document: DocumentRow; printJob: PrintJobRow | null }> {
    const document = await this.fulfillment.requestDocumentIn(tx, ctx, "handover_manifest", {
      orderIds: [],
      handoverId: h.id,
    });
    const printJob = print ? await this.print.queueIn(tx, ctx, document, print, `Manifest ${h.number}`) : null;
    return { document, printJob };
  }

  /** Manifests newest first ("Riwayat manifest"), in the caller's warehouses. */
  async list(
    ctx: RequestContext,
    f: { status?: HandoverStatus | undefined; warehouseId?: string | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: HandoverView[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const scope = ctx.warehouseScope ? [...ctx.warehouseScope] : null;
      const warehouseIds = f.warehouseId ? (scope && !scope.includes(f.warehouseId) ? [] : [f.warehouseId]) : scope;
      const rows = await this.repo.page(tx, { status: f.status, warehouseIds }, before, limit);
      const page = rows.slice(0, limit);
      const counts = await this.repo.itemCounts(
        tx,
        page.map((h) => h.id),
      );
      return { items: page.map((h) => ({ handover: h, parcels: counts.get(h.id) ?? 0 })), more: rows.length > limit };
    });
  }

  /** One manifest with its parcels in the order they were scanned. */
  async get(ctx: RequestContext, id: string): Promise<HandoverView & { items: HandoverItemRow[] }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const h = await this.getIn(tx, ctx, id);
      const items = await this.repo.items(tx, h.id);
      return { handover: h, parcels: items.length, items };
    });
  }

  // ---- full data export (FR-MIG-09) ----

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "serah_terima.csv",
        description: "Paket yang diserahkan ke kurir per manifest: kurir, gudang, nomor resi, dan penerimanya.",
        columns: [
          "no_manifest",
          "gudang",
          "kurir",
          "status",
          "selesai_pada",
          "diserahkan_oleh",
          "diterima_oleh",
          "no_resi",
          "no_pesanan",
          "dipindai_pada",
          "dipindai_oleh",
          "id_pesanan",
          "id_manifest",
          "id",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.exportPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map(({ item, h }) => [
                h.number,
                l.warehouseCode(h.warehouseId),
                h.courier,
                h.status,
                h.completedAt,
                l.userName(h.completedBy),
                h.receivedBy,
                item.trackingNumber,
                item.orderNumber,
                item.createdAt,
                l.userName(item.scannedBy),
                item.orderId,
                h.id,
                item.id,
              ]),
          ),
      },
    ];
  }
}
