import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { barcodeFor, code128Encodable, isValidGtin } from "../../common/barcode";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import type { DocumentResult } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { channelDisplayName, isManualChannel, StoresService } from "../channel/stores.service";
import { FilesService } from "../files/files.service";
import { TenantsService } from "../identity/tenants.service";
import { UsersService } from "../identity/users.service";
import { InventoryService } from "../inventory/inventory.service";
import { addressLine, WarehousesService, type WarehouseView } from "../inventory/warehouses.service";
import { OrderIntakeService } from "../orders/order-intake.service";
import type { OrderItemRow, OrderRow } from "../orders/orders.repository";
import { OrdersService } from "../orders/orders.service";
import { type DocumentRow, FulfillmentRepository } from "./fulfillment.repository";
import { HandoverRepository } from "./handover.repository";
import { LabelTemplateService } from "./label-template.service";
import {
  type BarcodeLabel,
  composeLabels,
  type LabelEntry,
  type ManualLabel,
  type PackingList,
  renderBarcodeLabels,
  renderManifest,
  renderManualLabel,
  renderPackingList,
  renderPickList,
  renderTestPage,
} from "./pdf";
import { type Missing, notPickable, PickListBuilder } from "./pick-list.builder";
import { PrintService } from "./print.service";
import { marketplaceLabelRefusal } from "./scan-plan";
import { type LabelTemplateOptions, labelSequence, manualLabelRefusal, templateStrip } from "./shipping-plan";

const log = logger.forModule("fulfillment.documents");

/** Merged label files and pick lists are kept a week: enough to print again, short for buyer data. */
export const DOCUMENT_TTL_DAYS = 7;

/** Documents without buyer names or addresses (stored as `pick_list` files). */
const WITHOUT_BUYER_DATA: ReadonlySet<DocumentRow["kind"]> = new Set(["pick_list", "handover_manifest", "test_page"]);

/** Nothing in the request can go on paper; the document fails with this reason and the missing list. */
class NothingToRender extends Error {
  constructor(
    readonly reason: string,
    readonly missing: NonNullable<DocumentResult["missing"]>,
  ) {
    super(reason);
  }
}

interface Rendered {
  pdf: Uint8Array;
  pages: number;
  result: DocumentResult;
  /** Orders whose labels went into the file. */
  printed: string[];
  /** Orders whose packing list went into the file (FR-SHP-03). */
  packingLists?: string[];
  /** Orders whose goods the pick list gathers (FR-SHP-02). */
  picked?: string[];
}

/**
 * Renders requested documents in the worker (queue `pdf`, backend doc 8.15): all labels of a set of
 * orders in one PDF, ordered like the pick list (FR-SHP-01), and the pick list itself (FR-SHP-02).
 * A document renders once; one that fails says why and can be requested again.
 */
@Injectable()
export class DocumentRenderService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(FulfillmentRepository) private readonly repo: FulfillmentRepository,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(OrderIntakeService) private readonly intake: OrderIntakeService,
    @Inject(PickListBuilder) private readonly pickLists: PickListBuilder,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(LabelTemplateService) private readonly templates: LabelTemplateService,
    @Inject(HandoverRepository) private readonly handovers: HandoverRepository,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PrintService) private readonly print: PrintService,
  ) {}

  async render(ctx: RequestContext, documentId: string): Promise<void> {
    const doc = await withTenantTx(this.db, ctx, async (tx) => {
      const d = await this.repo.getDocument(tx, documentId, true);
      if (d?.status !== "queued") return null;
      await this.repo.updateDocument(tx, d.id, { status: "running" });
      return d;
    });
    if (!doc) return;
    try {
      const out = await this.renderKind(ctx, doc);
      const file = await this.files.save(ctx, {
        // packing lists carry the buyer's name like labels, and live as long; pick lists, manifests, and
        // test pages carry no buyer data
        purpose: WITHOUT_BUYER_DATA.has(doc.kind) ? "pick_list" : "label",
        mime: "application/pdf",
        ext: "pdf",
        bytes: out.pdf,
        expiresAt: new Date(Date.now() + DOCUMENT_TTL_DAYS * 86_400_000),
        createdBy: doc.requestedBy,
      });
      const jobs = await withTenantTx(this.db, ctx, async (tx) => {
        await this.repo.updateDocument(tx, doc.id, {
          status: "ready",
          fileObjectId: file.id,
          pageCount: out.pages,
          result: out.result,
          finishedAt: new Date(),
        });
        const actor = doc.requestedBy
          ? { type: "user" as const, id: doc.requestedBy }
          : { type: "system" as const, id: null };
        // the order history says who printed what, and the team report counts it (FR-RPT-10)
        const note = { documentId: doc.id };
        await this.intake.recordManyIn(tx, ctx, out.printed, "label_printed", actor, note);
        await this.intake.recordManyIn(tx, ctx, out.packingLists ?? [], "packing_list_printed", actor, note);
        await this.intake.recordManyIn(tx, ctx, out.picked ?? [], "pick_list_printed", actor, note);
        return this.print.documentFinishedIn(tx, { id: doc.id, status: "ready", fileObjectId: file.id, error: null });
      });
      // print agents waiting for this document hear about it once the file is attached (FR-SHP-17)
      this.print.push(jobs);
    } catch (err) {
      const nothing = err instanceof NothingToRender;
      if (!nothing) log.error({ err, document_id: doc.id }, "document render failed");
      const error = nothing ? err.reason : "Dokumen gagal dibuat. Coba lagi.";
      await withTenantTx(this.db, ctx, async (tx) => {
        await this.repo.updateDocument(tx, doc.id, {
          status: "failed",
          error,
          ...(nothing ? { result: { missing: err.missing } } : {}),
          finishedAt: new Date(),
        });
        await this.print.documentFinishedIn(tx, { id: doc.id, status: "failed", fileObjectId: null, error });
      });
    }
  }

  private renderKind(ctx: RequestContext, doc: DocumentRow): Promise<Rendered> {
    switch (doc.kind) {
      case "labels":
        return this.labels(ctx, doc);
      case "packing_list":
        return this.packingLists(ctx, doc);
      case "barcode_labels":
        return this.barcodeLabels(ctx, doc);
      case "pick_list":
        return this.pickList(ctx, doc);
      case "handover_manifest":
        return this.manifest(ctx, doc);
      case "test_page":
        return this.testPage(ctx, doc);
    }
  }

  /** FR-SHP-05: a completed handover's manifest, parcels in the order they were scanned. */
  private async manifest(ctx: RequestContext, doc: DocumentRow): Promise<Rendered> {
    const business = await this.tenants.profile(ctx);
    const data = await withTenantTx(this.db, ctx, async (tx) => {
      const h = doc.params.handoverId ? await this.handovers.get(tx, doc.params.handoverId) : undefined;
      if (h?.status !== "completed") return null;
      const items = await this.handovers.items(tx, h.id);
      const { orders } = await this.orders.readIn(
        tx,
        items.map((i) => i.orderId),
      );
      const warehouse = await this.warehouses.anyIn(tx, h.warehouseId);
      const storeNames = await this.stores.namesIn(tx);
      return { h, items, orders, warehouse, storeNames, names: await this.users.namesIn(tx) };
    });
    if (!data) throw new NothingToRender("Manifest belum selesai atau sudah tidak ada.", []);
    const sourceOf = (orderId: string) => {
      const o = data.orders.find((x) => x.id === orderId);
      return o ? `${channelDisplayName(o.channel)} · ${data.storeNames.get(o.storeId) ?? ""}` : "";
    };
    const { pdf, pages } = await renderManifest({
      number: data.h.number,
      business: business.name,
      warehouse: {
        name: data.warehouse?.name ?? "",
        address: data.warehouse ? addressLine(data.warehouse.address) : "",
      },
      courier: data.h.courier,
      completedAt: data.h.completedAt!,
      timeZone: business.timezone,
      handedOverBy: data.h.completedBy ? (data.names.get(data.h.completedBy) ?? null) : null,
      receivedBy: data.h.receivedBy,
      parcels: data.items.map((i) => ({
        trackingNumber: i.trackingNumber,
        orderNumber: i.orderNumber,
        source: sourceOf(i.orderId),
        scannedAt: i.createdAt,
      })),
    });
    return { pdf, pages, result: { orders: data.items.length, missing: [] }, printed: [] };
  }

  /** UI L42 "Cetak percobaan": who sent the page to which agent and printer, and a barcode to scan. */
  private async testPage(ctx: RequestContext, doc: DocumentRow): Promise<Rendered> {
    const business = await this.tenants.profile(ctx);
    const { pdf, pages } = await renderTestPage({
      business: business.name,
      device: doc.params.device?.name ?? "",
      printer: doc.params.device?.printer ?? null,
      at: doc.createdAt,
      timeZone: business.timezone,
      barcode: barcodeFor(`TES-${doc.id.slice(-8)}`),
    });
    return { pdf, pages, result: { missing: [] }, printed: [] };
  }

  /** Everything labels and packing lists draw from, read in one transaction. */
  private load(ctx: RequestContext, ids: string[]) {
    return withTenantTx(this.db, ctx, async (tx) => {
      const { orders, items } = await this.orders.readIn(tx, ids);
      const shipments = await this.repo.liveFor(tx, ids);
      const packages = await this.repo.packages(
        tx,
        shipments.map((s) => s.id),
      );
      const warehouseOf = (i: (typeof items)[number]) =>
        i.warehouseId ?? orders.find((o) => o.id === i.orderId)?.warehouseId ?? null;
      const pairs = items
        .filter((i) => i.variantId && warehouseOf(i))
        .map((i) => ({ variantId: i.variantId!, warehouseId: warehouseOf(i)! }));
      const info = await this.inventory.pickInfoIn(tx, pairs);
      const warehouses = await this.warehouses.activeIn(tx);
      const tags = await this.orders.tagsIn(tx, ids);
      const storeNames = await this.stores.namesIn(tx);
      const template = await this.templates.optionsIn(tx);
      return { orders, items, shipments, packages, info, warehouses, warehouseOf, tags, storeNames, template };
    });
  }

  /** Open lines of an order with what printed documents show: SKU, product, variant, rack. */
  private lines(o: OrderRow, data: Awaited<ReturnType<DocumentRenderService["load"]>>) {
    return data.items
      .filter((i) => i.orderId === o.id && i.qty - i.cancelledQty > 0)
      .map((i) => {
        const v = i.variantId ? data.info.variants.get(i.variantId) : undefined;
        const wh = data.warehouseOf(i);
        return {
          qty: i.qty - i.cancelledQty,
          sku: v?.sku ?? (i.skuSnapshot || "(tanpa SKU)"),
          name: v?.productName ?? i.titleSnapshot,
          variant: v
            ? v.variantName !== v.productName
              ? v.variantName
              : null
            : (i.variantSnapshot.name as string) || null,
          bin: i.variantId && wh ? (data.info.bins.get(`${i.variantId}|${wh}`) ?? null) : null,
        };
      });
  }

  private sequenceOf(orders: OrderRow[], data: Awaited<ReturnType<DocumentRenderService["load"]>>): string[] {
    return labelSequence(
      orders.map((o) => ({
        orderId: o.id,
        warehouse: data.warehouses.find((w) => w.id === o.warehouseId)?.name ?? "",
        shipByAt: o.shipByAt,
        lines: this.lines(o, data).map((l) => ({ sku: l.sku, bin: l.bin })),
      })),
    );
  }

  /** One order's packing list (FR-SHP-03): enough to match the parcel, without the full address. */
  private packingListOf(
    o: OrderRow,
    data: Awaited<ReturnType<DocumentRenderService["load"]>>,
    template: LabelTemplateOptions,
  ): PackingList {
    const a = o.shippingAddress ?? {};
    return {
      number: o.externalOrderId,
      source: `${channelDisplayName(o.channel)} · ${data.storeNames.get(o.storeId) ?? ""}`,
      orderedAt: o.orderedAt,
      courier: [o.shippingProvider, o.shippingService].filter(Boolean).join(" · ") || null,
      trackingNumber: o.trackingNumber,
      buyer: o.buyerName ?? o.buyerUsername,
      destination: [a.city, a.province].filter(Boolean).join(", ") || null,
      lines: this.lines(o, data),
      note: o.buyerNote,
      tags: template.showTags ? (data.tags.get(o.id) ?? []) : [],
    };
  }

  private async labels(ctx: RequestContext, doc: DocumentRow): Promise<Rendered> {
    const ids = doc.params.orderIds;
    const business = (await this.tenants.profile(ctx)).name;
    const data = await this.load(ctx, ids);
    const custom = doc.params.template === "custom";

    const missing: Missing[] = [];
    // manual orders have no marketplace label: OmniSeller draws theirs (FR-WHS-08)
    const manual = new Map(data.orders.filter((o) => isManualChannel(o.channel)).map((o) => [o.id, o]));
    const printable = data.orders.filter((o) => {
      const s = data.shipments.find((x) => x.orderId === o.id);
      const why = manual.has(o.id)
        ? manualLabelRefusal({ status: o.status, hasAddress: !!o.shippingAddress?.line1 })
        : marketplaceLabelRefusal(s, s ? data.packages.filter((p) => p.shipmentId === s.id) : []);
      if (why) missing.push({ orderId: o.id, ...why });
      return !why;
    });
    const sequence = this.sequenceOf(printable, data);

    const entries: LabelEntry[] = [];
    const owner: { orderId: string; label: boolean }[] = [];
    for (const orderId of sequence) {
      const o = data.orders.find((x) => x.id === orderId)!;
      const own = manual.get(orderId);
      if (own) {
        entries.push({ pdf: await renderManualLabel(this.manualLabel(own, data, business)) });
        owner.push({ orderId, label: true });
      } else {
        const s = data.shipments.find((x) => x.orderId === orderId)!;
        const bytes: Uint8Array[] = [];
        for (const p of data.packages.filter((x) => x.shipmentId === s.id)) {
          const b = await this.files.read(ctx, p.labelFileId!);
          if (b) bytes.push(b);
        }
        if (bytes.length === 0) {
          missing.push({ orderId, code: "label.expired", message: "Label sudah tidak tersimpan." });
          continue;
        }
        // the custom template goes under marketplace labels only: OmniSeller's own label lists the items
        const strip = custom
          ? templateStrip(data.template, {
              number: o.externalOrderId,
              note: o.buyerNote,
              tags: data.tags.get(o.id) ?? [],
              lines: this.lines(o, data),
            })
          : null;
        for (const b of bytes) {
          entries.push({ pdf: b, strip });
          owner.push({ orderId, label: true });
        }
      }
      if (doc.params.packingList) {
        entries.push({ pdf: await renderPackingList(this.packingListOf(o, data, data.template)) });
        owner.push({ orderId, label: false });
      }
    }
    const composed = await composeLabels(entries, doc.params.format ?? "thermal");
    const unreadable = new Set(composed.unreadable.map((i) => owner[i]!.orderId));
    for (const orderId of unreadable) {
      missing.push({ orderId, code: "label.unreadable", message: "Berkas label dari marketplace tidak bisa dibaca." });
    }
    const printed = [...new Set(owner.map((x) => x.orderId))].filter((id) => !unreadable.has(id));
    const labelPages = composed.pagesPerEntry.reduce((n, pages, i) => n + (owner[i]!.label ? pages : 0), 0);
    if (labelPages === 0) throw new NothingToRender("Tidak ada label yang bisa dicetak dari pesanan ini.", missing);
    return {
      pdf: composed.pdf,
      pages: composed.pages,
      result: { orders: printed.length, labels: labelPages, missing },
      printed,
      // an order whose label is not there gets no packing list either
      packingLists: doc.params.packingList ? printed : [],
    };
  }

  /**
   * FR-PRD-12: each variant's barcode (EAN-13, EAN-8, or Code 128), or its SKU when it has none, `copies`
   * times, in the order asked. Variants deleted since the request, and codes no symbology can hold, are
   * left out with the reason.
   */
  private async barcodeLabels(ctx: RequestContext, doc: DocumentRow): Promise<Rendered> {
    const items = doc.params.items ?? [];
    const variants = await withTenantTx(this.db, ctx, (tx) =>
      this.inventory.variantsIn(
        tx,
        items.map((i) => i.variantId),
      ),
    );
    const missing: NonNullable<DocumentResult["missing"]> = [];
    const labels: BarcodeLabel[] = [];
    const owners: string[] = [];
    for (const item of items) {
      const v = variants.get(item.variantId);
      if (!v) {
        missing.push({ variantId: item.variantId, code: "variant.not_found", message: "Varian sudah dihapus." });
        continue;
      }
      const value = v.barcode ?? v.sku;
      if (!isValidGtin(value) && !code128Encodable(value)) {
        missing.push({
          variantId: v.variantId,
          code: "barcode.unencodable",
          message: `${v.barcode ? "Barcode" : "SKU"} varian ini berisi karakter yang tidak bisa dijadikan barcode. Isi barcodenya, atau buat barcode internal.`,
        });
        continue;
      }
      const barcode = barcodeFor(value);
      const subtitle = [v.variantName !== v.productName ? v.variantName : null, v.barcode ? v.sku : null]
        .filter(Boolean)
        .join(" · ");
      for (let k = 0; k < item.copies; k++) {
        labels.push({ title: v.productName, subtitle, barcode });
        owners.push(v.variantId);
      }
    }
    if (labels.length === 0) throw new NothingToRender("Tidak ada label barcode yang bisa dicetak.", missing);
    const out = await renderBarcodeLabels(labels, doc.params.labelFormat ?? "label_50x30");
    const dense = [...new Set(out.dense.map((i) => owners[i]!))];
    return {
      pdf: out.pdf,
      pages: out.pages,
      result: { labels: labels.length, missing, ...(dense.length > 0 ? { dense } : {}) },
      printed: [],
    };
  }

  /** FR-SHP-03: packing lists alone, in pick-list order, for orders still to pack and ship. */
  private async packingLists(ctx: RequestContext, doc: DocumentRow): Promise<Rendered> {
    const data = await this.load(ctx, doc.params.orderIds);
    const missing: Missing[] = [];
    const printable = data.orders.filter((o) => {
      const why = notPickable(o);
      if (why) missing.push(why);
      return !why;
    });
    if (printable.length === 0) throw new NothingToRender("Tidak ada pesanan yang perlu dikemas.", missing);
    const entries: LabelEntry[] = [];
    for (const orderId of this.sequenceOf(printable, data)) {
      const o = printable.find((x) => x.id === orderId)!;
      entries.push({ pdf: await renderPackingList(this.packingListOf(o, data, data.template)) });
    }
    const composed = await composeLabels(entries, doc.params.format ?? "thermal");
    return {
      pdf: composed.pdf,
      pages: composed.pages,
      result: { orders: printable.length, missing },
      printed: [],
      packingLists: printable.map((o) => o.id),
    };
  }

  /** What goes on a manual order's label; the sender is its warehouse (FR-WHS-08). */
  private manualLabel(
    o: OrderRow,
    data: {
      items: OrderItemRow[];
      warehouses: WarehouseView[];
      info: { variants: Map<string, { sku: string; productName: string; variantName: string; weightG: number }> };
    },
    business: string,
  ): ManualLabel {
    const w = data.warehouses.find((x) => x.id === o.warehouseId);
    const a = o.shippingAddress ?? {};
    const lines = data.items.filter((i) => i.orderId === o.id && i.qty - i.cancelledQty > 0);
    const weights = lines.map((i) => (i.variantId ? data.info.variants.get(i.variantId)?.weightG : undefined));
    return {
      number: o.externalOrderId,
      orderedAt: o.orderedAt,
      business,
      sender: {
        name: w?.address.contactName ?? business,
        phone: w?.address.phone ?? null,
        address: w ? addressLine(w.address) || w.name : "",
      },
      recipient: {
        name: a.name ?? o.buyerName ?? "",
        phone: a.phone ?? o.buyerPhone,
        address: [a.line1, a.district, a.city, a.province, a.postalCode].filter(Boolean).join(", "),
      },
      courier: [o.shippingProvider, o.shippingService].filter(Boolean).join(" · ") || null,
      trackingNumber: o.trackingNumber,
      cod: o.isCod ? o.total : null,
      items: lines.map((i) => {
        const v = i.variantId ? data.info.variants.get(i.variantId) : undefined;
        const name = v
          ? v.variantName !== v.productName
            ? `${v.productName} ${v.variantName}`
            : v.productName
          : i.titleSnapshot;
        return { sku: v?.sku ?? i.skuSnapshot, name, qty: i.qty - i.cancelledQty };
      }),
      weightG: weights.every((g) => g !== undefined)
        ? lines.reduce((n, i, k) => n + weights[k]! * (i.qty - i.cancelledQty), 0)
        : null,
      note: o.buyerNote,
    };
  }

  private async pickList(ctx: RequestContext, doc: DocumentRow): Promise<Rendered> {
    const built = await withTenantTx(this.db, ctx, (tx) => this.pickLists.buildIn(tx, doc.params.orderIds));
    if (built.sections.length === 0) {
      throw new NothingToRender("Tidak ada barang yang perlu diambil dari pesanan ini.", built.missing);
    }
    const { pdf, pages } = await renderPickList({
      generatedAt: new Date(),
      sections: built.sections.map((s) => ({ warehouse: s.warehouse, orders: s.orders, lines: s.lines })),
    });
    return {
      pdf,
      pages,
      result: { orders: built.sections.reduce((n, s) => n + s.orders, 0), missing: built.missing },
      printed: [],
      picked: built.orderIds,
    };
  }
}
