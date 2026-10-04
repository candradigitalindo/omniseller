import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import type { DocumentResult } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { isManualChannel } from "../channel/stores.service";
import { FilesService } from "../files/files.service";
import { TenantsService } from "../identity/tenants.service";
import { InventoryService } from "../inventory/inventory.service";
import { addressLine, WarehousesService, type WarehouseView } from "../inventory/warehouses.service";
import { OrderIntakeService } from "../orders/order-intake.service";
import type { OrderItemRow, OrderRow } from "../orders/orders.repository";
import { OrdersService } from "../orders/orders.service";
import { type DocumentRow, FulfillmentRepository, type PackageRow, type ShipmentRow } from "./fulfillment.repository";
import { composeLabels, type ManualLabel, renderManualLabel, renderPickList } from "./pdf";
import { type Missing, PickListBuilder } from "./pick-list.builder";
import { labelSequence, manualLabelRefusal } from "./shipping-plan";

const log = logger.forModule("fulfillment.documents");

/** Merged label files and pick lists are kept a week: enough to print again, short for buyer data. */
export const DOCUMENT_TTL_DAYS = 7;

/** Nothing in the request can go on paper; the document fails with this reason and the missing list. */
class NothingToRender extends Error {
  constructor(
    readonly reason: string,
    readonly missing: Missing[],
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
}

function whyNoLabel(s: ShipmentRow | undefined, packages: PackageRow[]): { code: string; message: string } | null {
  if (!s) return { code: "shipment.not_arranged", message: "Pengiriman belum diatur." };
  if (s.status === "pending") {
    return { code: "shipment.pending", message: s.lastError ?? "Pengiriman sedang diatur." };
  }
  if (s.status === "in_transit" || s.status === "delivered") {
    return { code: "shipment.shipped", message: "Paket sudah diserahkan ke kurir." };
  }
  if (packages.length === 0 || packages.some((p) => !p.labelFileId)) {
    return { code: "label.not_ready", message: s.lastError ?? "Label belum tersedia. Coba lagi sebentar." };
  }
  return null;
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
      const out = doc.kind === "labels" ? await this.labels(ctx, doc) : await this.pickList(ctx, doc);
      const file = await this.files.save(ctx, {
        purpose: doc.kind === "labels" ? "label" : "pick_list",
        mime: "application/pdf",
        ext: "pdf",
        bytes: out.pdf,
        expiresAt: new Date(Date.now() + DOCUMENT_TTL_DAYS * 86_400_000),
        createdBy: doc.requestedBy,
      });
      await withTenantTx(this.db, ctx, async (tx) => {
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
        for (const orderId of out.printed) {
          await this.intake.recordIn(tx, ctx, orderId, "label_printed", actor, { documentId: doc.id });
        }
      });
    } catch (err) {
      const nothing = err instanceof NothingToRender;
      if (!nothing) log.error({ err, document_id: doc.id }, "document render failed");
      await withTenantTx(this.db, ctx, (tx) =>
        this.repo.updateDocument(tx, doc.id, {
          status: "failed",
          error: nothing ? err.reason : "Dokumen gagal dibuat. Coba lagi.",
          ...(nothing ? { result: { missing: err.missing } } : {}),
          finishedAt: new Date(),
        }),
      );
    }
  }

  private async labels(ctx: RequestContext, doc: DocumentRow): Promise<Rendered> {
    const ids = doc.params.orderIds;
    const business = (await this.tenants.profile(ctx)).name;
    const data = await withTenantTx(this.db, ctx, async (tx) => {
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
      const [info, warehouses] = await Promise.all([
        this.inventory.pickInfoIn(tx, pairs),
        this.warehouses.activeIn(tx),
      ]);
      return { orders, items, shipments, packages, info, warehouses, warehouseOf };
    });

    const missing: Missing[] = [];
    // manual orders have no marketplace label: OmniSeller draws theirs (FR-WHS-08)
    const manual = new Map(data.orders.filter((o) => isManualChannel(o.channel)).map((o) => [o.id, o]));
    const printable = data.orders.filter((o) => {
      const s = data.shipments.find((x) => x.orderId === o.id);
      const why = manual.has(o.id)
        ? manualLabelRefusal({ status: o.status, hasAddress: !!o.shippingAddress?.line1 })
        : whyNoLabel(s, s ? data.packages.filter((p) => p.shipmentId === s.id) : []);
      if (why) missing.push({ orderId: o.id, ...why });
      return !why;
    });
    const sequence = labelSequence(
      printable.map((o) => ({
        orderId: o.id,
        warehouse: data.warehouses.find((w) => w.id === o.warehouseId)?.name ?? "",
        shipByAt: o.shipByAt,
        lines: data.items
          .filter((i) => i.orderId === o.id && i.qty - i.cancelledQty > 0)
          .map((i) => {
            const wh = data.warehouseOf(i);
            return {
              sku: (i.variantId ? data.info.variants.get(i.variantId)?.sku : undefined) ?? i.skuSnapshot,
              bin: i.variantId && wh ? (data.info.bins.get(`${i.variantId}|${wh}`) ?? null) : null,
            };
          }),
      })),
    );

    const files: Uint8Array[] = [];
    const owner: string[] = [];
    for (const orderId of sequence) {
      const own = manual.get(orderId);
      if (own) {
        files.push(await renderManualLabel(this.manualLabel(own, data, business)));
        owner.push(orderId);
        continue;
      }
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
      for (const b of bytes) {
        files.push(b);
        owner.push(orderId);
      }
    }
    const composed = await composeLabels(files, doc.params.format ?? "thermal");
    const unreadable = new Set(composed.unreadable.map((i) => owner[i]!));
    for (const orderId of unreadable) {
      missing.push({ orderId, code: "label.unreadable", message: "Berkas label dari marketplace tidak bisa dibaca." });
    }
    const printed = [...new Set(owner)].filter((id) => !unreadable.has(id));
    if (composed.labels === 0)
      throw new NothingToRender("Tidak ada label yang bisa dicetak dari pesanan ini.", missing);
    return {
      pdf: composed.pdf,
      pages: composed.pages,
      result: { orders: printed.length, labels: composed.labels, missing },
      printed,
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
    };
  }
}
