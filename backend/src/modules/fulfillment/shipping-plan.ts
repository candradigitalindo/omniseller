import type { OrderStatus, ShipmentStatus } from "@omniseller/shared";

/**
 * Fulfillment decisions as pure functions (backend doc 8.15, PRD FR-SHP-01, 02, 06): which orders may
 * have their shipment arranged, how a shipment follows its order, the order labels print in, the pick
 * list, and where labels go on a page. The services load data, call these, and write the result.
 */

/** Orders whose shipment may be arranged: new orders are accepted on the way (FR-ORD-08). */
export const ARRANGEABLE: ReadonlySet<OrderStatus> = new Set(["new", "ready_to_pack", "packed"]);

/** Statuses whose items still have to be picked from the shelf. */
export const PICKABLE: ReadonlySet<OrderStatus> = new Set(["new", "ready_to_pack", "packed", "ready_to_ship"]);

/**
 * Marketplace statuses in which the shipment can be arranged. Arranged already (Shopee PROCESSED,
 * TikTok Shop AWAITING_COLLECTION, for example in Seller Center) is accepted too: the connector adopts
 * the arrangement and OmniSeller fetches the label.
 */
const READY_AT_MARKETPLACE: Record<string, ReadonlySet<string>> = {
  shopee: new Set(["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED"]),
  tiktokshop: new Set(["AWAITING_SHIPMENT", "AWAITING_COLLECTION"]),
};

export interface Refusal {
  code: string;
  message: string;
}

export interface ArrangeCheck {
  status: OrderStatus;
  statusLabel: string;
  fulfillmentMode: "seller" | "marketplace";
  channel: string;
  externalStatus: string | null;
  cancelRequested: boolean;
  warehouseId: string | null;
  store: { live: boolean; usable: boolean } | null;
  /** The order's shipment that is not cancelled, if any. */
  shipment: { status: ShipmentStatus; lastError: string | null } | null;
}

/** Why the shipment of this order cannot be arranged now, or null when it can. */
export function arrangeRefusal(c: ArrangeCheck): Refusal | null {
  if (!c.store) return { code: "store.not_found", message: "Toko pesanan ini tidak ditemukan." };
  if (!c.store.live) {
    return {
      code: "store.read_only",
      message: "Toko masih mode baca saja. Proses pesanan ini di aplikasi lama sampai sinkron diaktifkan.",
    };
  }
  if (!c.store.usable) {
    return { code: "store.unusable", message: "Toko perlu dihubungkan ulang sebelum mengatur pengiriman." };
  }
  if (c.fulfillmentMode === "marketplace") {
    return { code: "order.marketplace_fulfilled", message: "Pesanan ini dikirim oleh marketplace." };
  }
  if (c.status === "problem") {
    return { code: "order.has_problems", message: "Selesaikan masalah pesanan ini dulu." };
  }
  if (!ARRANGEABLE.has(c.status)) {
    return {
      code: "order.status_invalid",
      message: `Pesanan berstatus ${c.statusLabel}; pengiriman diatur untuk pesanan Baru, Siap Dikemas, atau Dikemas.`,
    };
  }
  if (!c.warehouseId) return { code: "order.no_warehouse", message: "Gudang pesanan ini belum diketahui." };
  if (c.cancelRequested) {
    return {
      code: "order.cancel_requested",
      message: "Pembeli mengajukan pembatalan. Tanggapi pengajuannya dulu di Seller Center.",
    };
  }
  if (!READY_AT_MARKETPLACE[c.channel]?.has(c.externalStatus ?? "")) {
    return {
      code: "order.not_ready_at_marketplace",
      message: `Pesanan belum siap dikirim di marketplace (status ${c.externalStatus ?? "tidak diketahui"}).`,
    };
  }
  if (c.shipment && c.shipment.status !== "pending") {
    return { code: "shipment.already_arranged", message: "Pengiriman pesanan ini sudah diatur." };
  }
  if (c.shipment && !c.shipment.lastError) {
    return { code: "shipment.in_progress", message: "Pengiriman pesanan ini sedang diatur." };
  }
  return null;
}

export interface ShipmentStep {
  to: ShipmentStatus;
  /** `marketplace` steps skip seller steps and need withStatusSource(tx, "marketplace"). */
  via: "any" | "marketplace";
}

const BEFORE_HANDOVER: ReadonlySet<ShipmentStatus> = new Set(["pending", "arranged", "label_ready", "packed"]);

/**
 * The shipment step an order status brings (doc 7.9): cancelled before handover cancels it, the
 * marketplace's "shipped" puts it in transit, delivered or completed delivers it, and packing an order
 * whose label is ready packs it.
 */
export function shipmentStepFor(order: OrderStatus, shipment: ShipmentStatus): ShipmentStep | null {
  switch (order) {
    case "cancelled":
      return BEFORE_HANDOVER.has(shipment) ? { to: "cancelled", via: "any" } : null;
    case "shipped":
      if (BEFORE_HANDOVER.has(shipment)) return { to: "in_transit", via: "marketplace" };
      return shipment === "handed_over" ? { to: "in_transit", via: "any" } : null;
    case "delivered":
    case "completed":
      if (shipment === "in_transit") return { to: "delivered", via: "any" };
      if (BEFORE_HANDOVER.has(shipment) || shipment === "handed_over" || shipment === "failed") {
        return { to: "delivered", via: "marketplace" };
      }
      return null;
    case "packed":
      return shipment === "label_ready" ? { to: "packed", via: "any" } : null;
    default:
      return null;
  }
}

/** "A-2-10" before "A-10-1": rack codes compare by their numbers. */
export const compareBins = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, "id", { numeric: true, sensitivity: "base" });
};

export interface LabelSortInput {
  orderId: string;
  /** Warehouse code or name, so one warehouse's labels come together (FR-WHS-08). */
  warehouse: string;
  /** Bin and SKU of each open line. */
  lines: { bin: string | null; sku: string }[];
  shipByAt: Date | null;
}

/**
 * Labels print in the order of the pick list (FR-SHP-01): per warehouse, by the first rack the order
 * needs, then by SKU, so a packer walking the pick list meets the labels in the same order; orders
 * with the same single item come together. Ship-by date breaks ties.
 */
export function labelSequence(orders: LabelSortInput[]): string[] {
  const key = (o: LabelSortInput) => {
    const lines = [...o.lines].sort((a, b) => compareBins(a.bin, b.bin) || a.sku.localeCompare(b.sku));
    return { bin: lines[0]?.bin ?? null, sku: lines[0]?.sku ?? "" };
  };
  return [...orders]
    .map((o) => ({ o, k: key(o) }))
    .sort(
      (a, b) =>
        a.o.warehouse.localeCompare(b.o.warehouse) ||
        compareBins(a.k.bin, b.k.bin) ||
        a.k.sku.localeCompare(b.k.sku) ||
        (a.o.shipByAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.o.shipByAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
        a.o.orderId.localeCompare(b.o.orderId),
    )
    .map((x) => x.o.orderId);
}

export interface PickInput {
  orderId: string;
  warehouseId: string | null;
  /** null for a line whose SKU is not mapped yet: picked by the marketplace SKU and title. */
  variantId: string | null;
  sku: string;
  name: string;
  variantName: string | null;
  bin: string | null;
  qty: number;
}

export interface PickLine {
  warehouseId: string | null;
  variantId: string | null;
  sku: string;
  name: string;
  variantName: string | null;
  bin: string | null;
  qty: number;
  orders: number;
}

/** FR-SHP-02: units per SKU and warehouse, sorted by rack, then SKU. */
export function pickLines(inputs: PickInput[]): PickLine[] {
  const lines = new Map<string, PickLine & { orderIds: Set<string> }>();
  for (const i of inputs) {
    if (i.qty <= 0) continue;
    const key = `${i.warehouseId ?? ""}|${i.variantId ?? `sku:${i.sku}|${i.name}`}`;
    const line = lines.get(key) ?? {
      warehouseId: i.warehouseId,
      variantId: i.variantId,
      sku: i.sku,
      name: i.name,
      variantName: i.variantName,
      bin: i.bin,
      qty: 0,
      orders: 0,
      orderIds: new Set<string>(),
    };
    line.qty += i.qty;
    line.orderIds.add(i.orderId);
    line.orders = line.orderIds.size;
    lines.set(key, line);
  }
  return [...lines.values()]
    .map(({ orderIds: _, ...l }) => l)
    .sort(
      (a, b) =>
        (a.warehouseId ?? "").localeCompare(b.warehouseId ?? "") ||
        compareBins(a.bin, b.bin) ||
        a.sku.localeCompare(b.sku) ||
        a.name.localeCompare(b.name),
    );
}

/** PDF points per millimetre. */
export const MM = 72 / 25.4;
export const THERMAL_PAGE = { width: 100 * MM, height: 150 * MM };
export const A4_PAGE = { width: 210 * MM, height: 297 * MM };

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Scales a label page into a box, keeping its proportions, centred. */
export function fitInto(src: { width: number; height: number }, box: Box): { x: number; y: number; scale: number } {
  const scale = Math.min(box.width / src.width, box.height / src.height);
  return {
    scale,
    x: box.x + (box.width - src.width * scale) / 2,
    y: box.y + (box.height - src.height * scale) / 2,
  };
}

/** The four quarters of an A4 sheet in reading order (PDF y grows upwards). */
export function a4Cells(): Box[] {
  const w = A4_PAGE.width / 2;
  const h = A4_PAGE.height / 2;
  return [
    { x: 0, y: h, width: w, height: h },
    { x: w, y: h, width: w, height: h },
    { x: 0, y: 0, width: w, height: h },
    { x: w, y: 0, width: w, height: h },
  ];
}
