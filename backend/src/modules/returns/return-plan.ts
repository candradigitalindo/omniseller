import type { NormalizedReturnItem, ReturnState } from "@omniseller/connector-core";
import type { ReturnRequestKind, ReturnRequestStatus } from "@omniseller/shared";
import type { ReturnDecisionOption } from "../../db/schema";

/**
 * Return decisions as pure functions (backend doc 8.26, PRD FR-RET-01..07): the status a marketplace
 * snapshot leads to, which order lines a request's units come from, what a decision and a receipt must
 * hold, and when a deadline is close. The services load data, call these, and write the result.
 */

/** Statuses after which nothing more happens, unless the marketplace opens the request again. */
export const FINAL_STATUSES: ReadonlySet<ReturnRequestStatus> = new Set(["refunded", "cancelled", "closed"]);

/** The deadline alert goes out this long before the marketplace decides by itself (FR-RET-07). */
export const DUE_ALERT_MS = 12 * 3600_000;

/** Photos per decision; the marketplaces take more, a seller rarely needs them. */
export const MAX_RESPONSE_PHOTOS = 9;

/** Photos a seller may upload to one request. */
export const MAX_SELLER_EVIDENCE = 20;

/**
 * The status a marketplace snapshot leads to, or null to keep the current one. Open requests follow
 * the marketplace wherever it goes (a late webhook, arbitration); a final one only opens again.
 */
export function nextStatus(current: ReturnRequestStatus, fact: ReturnState): ReturnRequestStatus | null {
  if (current === fact) return null;
  if (FINAL_STATUSES.has(current)) return fact === "requested" ? "requested" : null;
  return fact;
}

/** Kinds whose units the buyer may send back; cancellations never ship. */
export const goodsKinds: ReadonlySet<ReturnRequestKind> = new Set(["return_refund", "replacement", "exchange", "rto"]);

export interface OrderLine {
  id: string;
  /** Marketplace listing item and variant of the line ("" variant for items without variants). */
  externalProductId: string | null;
  externalSkuId: string | null;
  skuSnapshot: string;
  titleSnapshot: string;
  qty: number;
  cancelledQty: number;
  shippedQty: number;
  returnedQty: number;
}

export interface PlannedItem {
  orderItemId: string | null;
  externalItemId: string;
  externalVariantId: string;
  sku: string | null;
  title: string | null;
  qty: number;
  refundAmount: number | null;
}

/** Splits an amount over quantities, the rounding left on the last part. */
function split(amount: number | null, parts: number[]): (number | null)[] {
  if (amount === null) return parts.map(() => null);
  const total = parts.reduce((n, p) => n + p, 0);
  let left = amount;
  return parts.map((p, i) => {
    if (i === parts.length - 1) return left;
    const share = Math.round((amount * p) / total);
    left -= share;
    return share;
  });
}

/**
 * The order lines a request's units come from: same listing variant, and same listing item when the
 * marketplace names it (TikTok Shop names the SKU only). Units of one variant spread over several lines
 * (Shopee promotion groups) fill each line up to its units not cancelled, in line order; units no line
 * can take stay without a line. Lines are merged, so a line appears once per request.
 */
export function matchItems(lines: readonly OrderLine[], items: readonly NormalizedReturnItem[]): PlannedItem[] {
  const out: PlannedItem[] = [];
  const taken = new Map<string, number>();
  for (const it of items) {
    if (it.quantity <= 0) continue;
    const candidates = lines.filter(
      (l) =>
        (l.externalSkuId ?? "") === it.externalVariantId &&
        (it.externalItemId === "" || l.externalProductId === it.externalItemId),
    );
    const parts: { orderItemId: string | null; qty: number }[] = [];
    let left = it.quantity;
    for (const l of candidates) {
      if (left <= 0) break;
      const room = Math.max(0, l.qty - l.cancelledQty - (taken.get(l.id) ?? 0));
      const n = Math.min(left, room);
      if (n <= 0) continue;
      taken.set(l.id, (taken.get(l.id) ?? 0) + n);
      parts.push({ orderItemId: l.id, qty: n });
      left -= n;
    }
    if (left > 0) parts.push({ orderItemId: null, qty: left });
    const refunds = split(
      it.refundAmount,
      parts.map((p) => p.qty),
    );
    parts.forEach((p, i) => {
      const line = p.orderItemId ? lines.find((l) => l.id === p.orderItemId) : undefined;
      out.push({
        orderItemId: p.orderItemId,
        externalItemId: it.externalItemId || (line?.externalProductId ?? ""),
        externalVariantId: it.externalVariantId,
        sku: it.sku ?? line?.skuSnapshot ?? null,
        title: it.title ?? line?.titleSnapshot ?? null,
        qty: p.qty,
        refundAmount: refunds[i] ?? null,
      });
    });
  }
  // one row per order line: two request items on the same line add up
  const merged: PlannedItem[] = [];
  for (const p of out) {
    const same = p.orderItemId ? merged.find((m) => m.orderItemId === p.orderItemId) : undefined;
    if (!same) {
      merged.push({ ...p });
      continue;
    }
    same.qty += p.qty;
    same.refundAmount =
      same.refundAmount === null && p.refundAmount === null ? null : (same.refundAmount ?? 0) + (p.refundAmount ?? 0);
  }
  return merged;
}

/** Units a returning parcel (rto) holds: what each line shipped and has not come back yet. */
export function rtoItems(lines: readonly OrderLine[]): PlannedItem[] {
  return lines
    .filter((l) => l.shippedQty - l.returnedQty > 0)
    .map((l) => ({
      orderItemId: l.id,
      externalItemId: l.externalProductId ?? "",
      externalVariantId: l.externalSkuId ?? "",
      sku: l.skuSnapshot || null,
      title: l.titleSnapshot,
      qty: l.shippedQty - l.returnedQty,
      refundAmount: null,
    }));
}

/** Items differ in what they hold (a later snapshot changed the request). */
export function itemsChanged(
  stored: readonly Pick<PlannedItem, "orderItemId" | "externalItemId" | "externalVariantId" | "qty">[],
  planned: readonly Pick<PlannedItem, "orderItemId" | "externalItemId" | "externalVariantId" | "qty">[],
): boolean {
  const key = (i: (typeof planned)[number]) =>
    `${i.orderItemId ?? ""}|${i.externalItemId}|${i.externalVariantId}|${i.qty}`;
  const a = stored.map(key).sort().join(",");
  const b = planned.map(key).sort().join(",");
  return a !== b;
}

export interface Problem {
  path: string;
  message: string;
}

export interface ResponseInput {
  decision: string;
  reason: string | null;
  comment: string | null;
  evidence: { fileId: string; module: number | null }[];
  email: string | null;
}

/**
 * What is wrong with a decision against the options the marketplace gives now: the decision must be
 * one of them, a rejection with reasons needs one, photos must be the request's own uploads, every
 * evidence module the reason requires needs a photo, and Shopee disputes need a contact email.
 */
export function responseProblems(
  options: readonly ReturnDecisionOption[],
  input: ResponseInput,
  uploaded: ReadonlySet<string>,
): Problem[] {
  const option = options.find((o) => o.code === input.decision);
  if (!option) return [{ path: "decision", message: "Keputusan ini tidak tersedia untuk pengajuan ini sekarang." }];
  const out: Problem[] = [];
  if (option.action === "accept") return out;
  const reason = input.reason ? option.reasons.find((r) => r.code === input.reason) : undefined;
  if (option.reasons.length > 0 && !input.reason) out.push({ path: "reason", message: "Pilih alasan penolakan." });
  else if (input.reason && !reason)
    out.push({ path: "reason", message: "Alasan ini tidak tersedia untuk pengajuan ini." });
  if (option.needsEmail && !input.email) {
    out.push({ path: "email", message: "Email kontak wajib untuk sanggahan ke marketplace." });
  }
  if (input.evidence.length > MAX_RESPONSE_PHOTOS) {
    out.push({ path: "evidence", message: `Paling banyak ${MAX_RESPONSE_PHOTOS} foto.` });
  }
  const modules = reason?.evidence ?? [];
  input.evidence.forEach((e, i) => {
    if (!uploaded.has(e.fileId))
      out.push({ path: `evidence.${i}.fileId`, message: "Foto tidak ditemukan pada pengajuan ini." });
    if (modules.length > 0 && !modules.some((m) => m.module === e.module)) {
      out.push({ path: `evidence.${i}.module`, message: "Pilih bukti yang diminta untuk foto ini." });
    }
  });
  for (const m of modules) {
    if (m.required && !input.evidence.some((e) => e.module === m.module)) {
      out.push({ path: "evidence", message: `Foto wajib: ${m.requirement || `bukti ${m.module}`}.` });
    }
  }
  return out;
}

export interface ReceiptItem {
  id: string;
  qty: number;
  orderItemId: string | null;
  /** The order line's variant now; null when the SKU is not mapped. */
  variantId: string | null;
}

export interface ReceiptLine {
  returnItemId: string;
  sellable: number;
  damaged: number;
  missing: number;
}

/**
 * What is wrong with a receipt (FR-RET-03): every item of the request counted once, its units adding up
 * to what the request holds, and units back in stock or quarantine only for lines with a product.
 */
export function receiptProblems(items: readonly ReceiptItem[], lines: readonly ReceiptLine[]): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    const item = items.find((x) => x.id === l.returnItemId);
    if (!item) {
      out.push({ path: `items.${i}.returnItemId`, message: "Barang ini bukan bagian dari pengajuan." });
      return;
    }
    if (seen.has(item.id)) {
      out.push({ path: `items.${i}.returnItemId`, message: "Barang ini disebut dua kali." });
      return;
    }
    seen.add(item.id);
    if (l.sellable + l.damaged + l.missing !== item.qty) {
      out.push({
        path: `items.${i}`,
        message: `Jumlah layak jual, rusak, dan tidak diterima harus ${item.qty}.`,
      });
    }
    if (!item.variantId && l.sellable + l.damaged > 0) {
      out.push({
        path: `items.${i}`,
        message: "SKU ini belum terhubung ke produk OmniSeller. Hubungkan dulu, atau catat sebagai tidak diterima.",
      });
    }
  });
  items.forEach((item) => {
    if (!seen.has(item.id)) out.push({ path: "items", message: `Kondisi barang ${item.id} belum diisi.` });
  });
  return out;
}
