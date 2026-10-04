import type { OrderStatus, ShipmentStatus } from "@omniseller/shared";
import type { DocumentKind, DocumentParams, PrintJobKind } from "../../db/schema";
import { manualLabelRefusal, type Refusal } from "./shipping-plan";

/**
 * Scanning at the warehouse as pure functions (backend doc 8.24; PRD FR-SHP-04, 05, 17): whether an
 * order's label can be printed, what a print job is called and which printer takes it, whether a parcel
 * may go into a courier handover, and whether the scanned items match the order. The services load
 * data, call these, and write the result.
 */

// ---- labels ----

/** Why a marketplace order has no label to print yet; null when every package has its label. */
export function marketplaceLabelRefusal(
  s: { status: ShipmentStatus; lastError: string | null } | undefined,
  packages: { labelFileId: string | null }[],
): Refusal | null {
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
 * Why this order's label cannot be printed now (FR-SHP-17): OmniSeller draws manual orders' labels,
 * marketplace orders need theirs fetched first.
 */
export function labelRefusal(
  o: { manual: boolean; status: OrderStatus; hasAddress: boolean },
  s: { status: ShipmentStatus; lastError: string | null } | undefined,
  packages: { labelFileId: string | null }[],
): Refusal | null {
  if (o.status === "cancelled") return { code: "order.cancelled", message: "Pesanan ini dibatalkan." };
  return o.manual
    ? manualLabelRefusal({ status: o.status, hasAddress: o.hasAddress })
    : marketplaceLabelRefusal(s, packages);
}

// ---- printing ----

export const PRINT_KIND: Record<DocumentKind, PrintJobKind> = {
  labels: "label",
  pick_list: "pick_list",
  packing_list: "packing_list",
  barcode_labels: "barcode",
  handover_manifest: "manifest",
  test_page: "test",
};

/** Label stock (thermal, barcode labels) or A4 paper: which of the agent's printers takes a job. */
export type Paper = "label" | "a4";

export function paperOf(kind: DocumentKind, params: DocumentParams): Paper {
  switch (kind) {
    case "labels":
    case "packing_list":
      return params.format === "a4" ? "a4" : "label";
    case "barcode_labels":
      return params.labelFormat === "a4_3x10" ? "a4" : "label";
    case "test_page":
      return "label";
    case "pick_list":
    case "handover_manifest":
      return "a4";
  }
}

/** The printer asked for, else the agent's printer for this paper, else null: the computer's default. */
export function printerFor(
  requested: string | null | undefined,
  paper: Paper,
  device: { labelPrinter: string | null; documentPrinter: string | null },
): string | null {
  if (requested) return requested;
  return (paper === "a4" ? device.documentPrinter : device.labelPrinter) ?? null;
}

/** What the print queue shows (UI L07): "Label 2609ABC", "Label 12 pesanan", "Manifest SRT-2610-0001". */
export function printTitle(kind: DocumentKind, params: DocumentParams, ref: { number?: string | null } = {}): string {
  const n = params.orderIds.length;
  const one = n === 1 && ref.number ? ref.number : null;
  switch (kind) {
    case "labels":
      return one ? `Label ${one}` : `Label ${n} pesanan`;
    case "packing_list":
      return one ? `Daftar kemas ${one}` : `Daftar kemas ${n} pesanan`;
    case "pick_list":
      return `Daftar ambil ${n} pesanan`;
    case "barcode_labels":
      return `Label barcode ${(params.items ?? []).reduce((sum, i) => sum + i.copies, 0)} lembar`;
    case "handover_manifest":
      return ref.number ? `Manifest ${ref.number}` : "Manifest serah terima";
    case "test_page":
      return "Cetak percobaan";
  }
}

// ---- courier handover (FR-SHP-05) ----

/** Manifest numbers per business and month of its time zone: MNF-2610-0001. */
export const handoverNumber = (period: string, n: number): string => `MNF-${period}-${String(n).padStart(4, "0")}`;

const courierKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The parcel goes with this courier: names compared without case, spaces, or punctuation, and one may
 * start the other ("JNE" takes "JNE Reguler"; "J&T Express" does not take "J&T Cargo"). A parcel whose
 * courier is unknown goes with any.
 */
export function courierMatches(courier: string, provider: string | null): boolean {
  const a = courierKey(courier);
  const b = provider ? courierKey(provider) : "";
  if (!a || !b) return true;
  return a.startsWith(b) || b.startsWith(a);
}

const SENT: ReadonlySet<OrderStatus> = new Set(["shipped", "delivered", "completed", "return_in_progress", "returned"]);
const SHIPMENT_SENT: ReadonlySet<ShipmentStatus> = new Set([
  "handed_over",
  "in_transit",
  "delivered",
  "failed",
  "rto_in_transit",
  "rto_received",
]);

export interface HandoverParcel {
  manual: boolean;
  orderStatus: OrderStatus;
  fulfillmentMode: "seller" | "marketplace";
  warehouseId: string | null;
  hasAddress: boolean;
  /** The order's live shipment (marketplace orders). */
  shipmentStatus: ShipmentStatus | null;
  /** The courier on the shipment or order. */
  provider: string | null;
}

/**
 * Why this parcel cannot go into this courier's manifest now; null: scan it in. Marketplace parcels
 * must be packed with their label (shipment `packed`); manual orders packed or ready to ship.
 */
export function handoverRefusal(p: HandoverParcel, h: { warehouseId: string; courier: string }): Refusal | null {
  if (p.orderStatus === "cancelled" || p.shipmentStatus === "cancelled") {
    return { code: "handover.cancelled", message: "Pesanan ini dibatalkan. Jangan serahkan paketnya." };
  }
  if (p.fulfillmentMode === "marketplace") {
    return { code: "order.marketplace_fulfilled", message: "Pesanan ini dikirim oleh marketplace." };
  }
  if (p.warehouseId !== h.warehouseId) {
    return { code: "handover.other_warehouse", message: "Paket ini dari gudang lain." };
  }
  if (SENT.has(p.orderStatus) || (p.shipmentStatus && SHIPMENT_SENT.has(p.shipmentStatus))) {
    return { code: "handover.already_sent", message: "Paket ini sudah diserahkan ke kurir." };
  }
  if (p.manual) {
    if (p.orderStatus !== "packed" && p.orderStatus !== "ready_to_ship") {
      return { code: "handover.not_packed", message: "Pesanan ini belum dikemas." };
    }
    if (!p.hasAddress) return { code: "order.no_address", message: "Pesanan ini tanpa alamat kirim." };
  } else if (p.shipmentStatus === "label_ready") {
    return { code: "handover.not_packed", message: "Pesanan ini belum dikemas." };
  } else if (p.shipmentStatus !== "packed") {
    return { code: "handover.not_ready", message: "Label pesanan ini belum siap." };
  }
  if (!courierMatches(h.courier, p.provider)) {
    return { code: "handover.courier_mismatch", message: `Paket ini untuk ${p.provider}, bukan ${h.courier}.` };
  }
  return null;
}

// ---- packing by scan (FR-SHP-04) ----

export interface PackLine {
  /** The variant id, or `sku:<SKU on the order>` for a line without a product in OmniSeller. */
  key: string;
  qty: number;
  /** What counts as this line when scanned: barcode, SKU (any case), and the key itself (tapped by hand). */
  codes: string[];
}

export interface PackingCheck {
  ok: boolean;
  lines: { key: string; expected: number; scanned: number }[];
  /** Scanned codes that are not on the order. */
  unknown: string[];
}

/**
 * Each scanned code counts toward the line it names; the order matches when every line has exactly its
 * quantity and nothing else was scanned. A code on two lines fills the first that still needs units.
 */
export function checkPacking(lines: PackLine[], scans: { code: string; qty: number }[]): PackingCheck {
  const scanned = new Map(lines.map((l) => [l.key, 0]));
  const unknown: string[] = [];
  const matches = (l: PackLine, code: string) =>
    l.codes.some((c) => c === code || c.toLowerCase() === code.toLowerCase());
  for (const s of scans) {
    const candidates = lines.filter((l) => matches(l, s.code));
    if (candidates.length === 0) {
      if (!unknown.includes(s.code)) unknown.push(s.code);
      continue;
    }
    let left = s.qty;
    for (const l of candidates) {
      const room = Math.max(0, l.qty - scanned.get(l.key)!);
      const take = l === candidates[candidates.length - 1] ? left : Math.min(room, left);
      scanned.set(l.key, scanned.get(l.key)! + take);
      left -= take;
      if (left === 0) break;
    }
  }
  const out = lines.map((l) => ({ key: l.key, expected: l.qty, scanned: scanned.get(l.key)! }));
  return { ok: unknown.length === 0 && out.every((l) => l.scanned === l.expected), lines: out, unknown };
}
