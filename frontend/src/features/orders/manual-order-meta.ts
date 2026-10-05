import type { components } from "@/lib/api/schema";

export type ManualOrderBody = components["schemas"]["CreateManualOrderDto"];
export type PaymentMethod = ManualOrderBody["paymentMethod"];

/** How the buyer pays (backend 8.21); COD is paid when the parcel arrives. */
export const PAYMENT_METHODS = [
  "transfer",
  "cash",
  "ewallet",
  "cod",
  "other",
] as const satisfies readonly PaymentMethod[];

/** Couriers offered while typing; any other name is fine too. */
export const COURIERS = [
  "JNE",
  "J&T Express",
  "SiCepat",
  "AnterAja",
  "Pos Indonesia",
  "Ninja Xpress",
  "ID Express",
  "Lion Parcel",
  "GoSend",
  "GrabExpress",
] as const;

/** How far back an order may be recorded (backend 8.21). */
export const MAX_DAYS_BACK = 90;

export interface PickedVariant {
  variantId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  basePrice: number;
  /** ready-to-sell stock per warehouse the user sees; null when stock is unknown to the user */
  stock: Record<string, number> | null;
}

export interface DraftLine extends PickedVariant {
  qty: string;
  unitPrice: string;
}

export interface Draft {
  /** "": the first manual channel, made on the first order */
  storeId: string;
  /** "": the nearest warehouse that holds every item */
  warehouseId: string;
  buyerName: string;
  buyerPhone: string;
  shipTo: "address" | "pickup";
  recipientName: string;
  recipientPhone: string;
  line1: string;
  district: string;
  city: string;
  province: string;
  postalCode: string;
  shippingProvider: string;
  shippingService: string;
  lines: DraftLine[];
  shippingFee: string;
  discount: string;
  paymentMethod: PaymentMethod;
  paid: boolean;
  buyerNote: string;
  internalNote: string;
  /** "": now; else a local date and time ("2026-10-05T14:30") in the business's time zone */
  orderedAt: string;
}

export function emptyDraft(): Draft {
  return {
    storeId: "",
    warehouseId: "",
    buyerName: "",
    buyerPhone: "",
    shipTo: "address",
    recipientName: "",
    recipientPhone: "",
    line1: "",
    district: "",
    city: "",
    province: "",
    postalCode: "",
    shippingProvider: "",
    shippingService: "",
    lines: [],
    shippingFee: "",
    discount: "",
    paymentMethod: "transfer",
    paid: false,
    buyerNote: "",
    internalNote: "",
    orderedAt: "",
  };
}

/** Cash is paid on the spot; the others are paid later unless the seller says so (backend 8.21). */
export function defaultPaid(method: PaymentMethod): boolean {
  return method === "cash";
}

const WHOLE = /^\d+$/;
const PHONE = /^\+?[\d\s-]{7,20}$/;

/** A whole rupiah amount or count typed in a box; blank is 0. */
export function amount(value: string): number {
  const v = value.trim();
  return WHOLE.test(v) ? Number(v) : 0;
}

/** Adds a variant, or one more of it when it is already on the order. */
export function addLine(lines: DraftLine[], v: PickedVariant): DraftLine[] {
  const found = lines.find((l) => l.variantId === v.variantId);
  if (found) {
    return lines.map((l) => (l === found ? { ...l, qty: String(amount(l.qty) + 1) } : l));
  }
  return [...lines, { ...v, qty: "1", unitPrice: String(v.basePrice) }];
}

/** Stock a line can take from: the chosen warehouse, or every warehouse when the api picks one. */
export function availableFor(line: Pick<DraftLine, "stock">, warehouseId: string): number | null {
  if (!line.stock) return null;
  if (warehouseId) return line.stock[warehouseId] ?? 0;
  return Math.max(0, ...Object.values(line.stock));
}

export function totals(d: Pick<Draft, "lines" | "discount" | "shippingFee" | "shipTo">) {
  const subtotal = d.lines.reduce((sum, l) => sum + amount(l.qty) * amount(l.unitPrice), 0);
  const discount = amount(d.discount);
  const shippingFee = d.shipTo === "address" ? amount(d.shippingFee) : 0;
  return { subtotal, discount, shippingFee, total: subtotal - discount + shippingFee };
}

export type Problem =
  | "required"
  | "noItems"
  | "qty"
  | "price"
  | "money"
  | "discountTooBig"
  | "phone"
  | "phoneNeeded"
  | "orderedAtRange";

/**
 * What stops the order, keyed by the api's field paths (`buyer.name`, `items.0.qty`), so the api's own field
 * errors land on the same fields.
 */
export function draftProblems(d: Draft, now: string, earliest: string): Record<string, Problem> {
  const out: Record<string, Problem> = {};
  if (d.lines.length === 0) out.items = "noItems";
  d.lines.forEach((l, i) => {
    if (!WHOLE.test(l.qty.trim()) || amount(l.qty) < 1) out[`items.${i}.qty`] = "qty";
    if (!WHOLE.test(l.unitPrice.trim())) out[`items.${i}.unitPrice`] = "price";
  });
  if (!d.buyerName.trim()) out["buyer.name"] = "required";
  if (d.buyerPhone.trim() && !PHONE.test(d.buyerPhone.trim())) out["buyer.phone"] = "phone";
  if (d.shipTo === "address") {
    if (!d.line1.trim()) out["shippingAddress.line1"] = "required";
    if (d.recipientPhone.trim() && !PHONE.test(d.recipientPhone.trim())) out["shippingAddress.phone"] = "phone";
    else if (!d.recipientPhone.trim() && !d.buyerPhone.trim()) out["shippingAddress.phone"] = "phoneNeeded";
    if (d.shippingFee.trim() && !WHOLE.test(d.shippingFee.trim())) out.shippingFee = "money";
  }
  if (d.discount.trim() && !WHOLE.test(d.discount.trim())) out.discount = "money";
  else if (amount(d.discount) > totals(d).subtotal) out.discount = "discountTooBig";
  if (d.orderedAt && (d.orderedAt > now || d.orderedAt < earliest)) out.orderedAt = "orderedAtRange";
  return out;
}

const optional = (key: string, value: string) => (value.trim() ? { [key]: value.trim() } : {});

/** The request for `POST /v1/orders/manual`; prices are sent as shown, so the order keeps what was agreed. */
export function manualOrderBody(d: Draft, timeZone: string): ManualOrderBody {
  const address = d.shipTo === "address";
  return {
    ...(d.storeId ? { storeId: d.storeId } : {}),
    ...(d.warehouseId ? { warehouseId: d.warehouseId } : {}),
    buyer: { name: d.buyerName.trim(), ...optional("phone", d.buyerPhone) },
    shippingAddress: address
      ? {
          line1: d.line1.trim(),
          ...optional("name", d.recipientName),
          ...optional("phone", d.recipientPhone),
          ...optional("district", d.district),
          ...optional("city", d.city),
          ...optional("province", d.province),
          ...optional("postalCode", d.postalCode),
        }
      : null,
    items: d.lines.map((l) => ({ variantId: l.variantId, qty: amount(l.qty), unitPrice: amount(l.unitPrice) })),
    shippingFee: address ? amount(d.shippingFee) : 0,
    discount: amount(d.discount),
    paymentMethod: d.paymentMethod,
    ...(d.paymentMethod === "cod" ? {} : { paid: d.paid }),
    ...(address
      ? { ...optional("shippingProvider", d.shippingProvider), ...optional("shippingService", d.shippingService) }
      : {}),
    ...optional("buyerNote", d.buyerNote),
    ...optional("internalNote", d.internalNote),
    ...(d.orderedAt ? { orderedAt: zonedToIso(d.orderedAt, timeZone) } : {}),
  };
}

const partsFormat = new Map<string, Intl.DateTimeFormat>();

function wallClock(at: number, timeZone: string): number {
  let f = partsFormat.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormat.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}

/** "2026-10-05T14:30" on the business's clock as an instant. */
export function zonedToIso(local: string, timeZone: string): string {
  const [date, time = "00:00"] = local.split("T") as [string, string?];
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, min] = time.split(":").map(Number) as [number, number];
  const asUtc = Date.UTC(y, m - 1, d, h, min);
  // the zone's offset at that moment, twice for a clock change in between
  let at = asUtc - (wallClock(asUtc, timeZone) - asUtc);
  at = asUtc - (wallClock(at, timeZone) - at);
  return new Date(at).toISOString();
}

/** An instant as "2026-10-05T14:30" on the business's clock, for `<input type="datetime-local">`. */
export function localInput(at: Date, timeZone: string): string {
  return new Date(wallClock(at.getTime(), timeZone)).toISOString().slice(0, 16);
}
