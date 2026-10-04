import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type ReturnItem = components["schemas"]["ReturnPageDto_Output"]["items"][number];
export type ReturnDetail = components["schemas"]["ReturnDto_Output"];
export type ReturnStatus = ReturnDetail["status"];
export type ReturnKind = ReturnDetail["kind"];
export type Decision = NonNullable<ReturnDetail["decisions"]>[number];
export type DecisionReason = Decision["reasons"][number];

/** The three tabs of L09, as the api groups them (`?group=`). */
export const RETURN_TABS = ["returns", "cancellations", "rto"] as const;
export type ReturnTab = (typeof RETURN_TABS)[number];

export function returnTabOf(value: string | null): ReturnTab {
  return RETURN_TABS.find((t) => t === value) ?? "returns";
}

/** Pill per status: requests the seller still has to answer are not red; the deadline pill is. */
export const RETURN_TONE: Record<ReturnStatus, Tone> = {
  requested: "info",
  negotiating: "warning",
  accepted: "info",
  in_transit: "info",
  rejected: "neutral",
  disputed: "warning",
  refunded: "success",
  cancelled: "neutral",
  closed: "neutral",
};

/** Time left to answer before the marketplace decides by itself (FR-RET-07); null without a deadline. */
export function answerWindow(r: Pick<ReturnItem, "respondByAt" | "awaitingDecision">, now: number): number | null {
  if (!r.awaitingDecision || !r.respondByAt) return null;
  return Date.parse(r.respondByAt) - now;
}

/** The deadline pill (8.6): red under 12 hours (the api's "due soon"), yellow under a day, green beyond. */
export function windowTone(ms: number): Tone {
  if (ms < 12 * 3_600_000) return "danger";
  if (ms < 24 * 3_600_000) return "warning";
  return "success";
}

/** Whether the warehouse can record what came back: goods travel back and nothing was recorded yet. */
export function canReceive(r: Pick<ReturnDetail, "goodsReturn" | "receivedAt" | "status">): boolean {
  return r.goodsReturn && r.receivedAt === null && r.status !== "rejected" && r.status !== "cancelled";
}

export type ReceiptLine = { returnItemId: string; sellable: number; damaged: number; missing: number };

/** Every unit back and sellable, as most returns arrive; the warehouse changes what differs. */
export function receiptDefaults(items: readonly Pick<ReturnDetail["items"][number], "id" | "qty">[]): ReceiptLine[] {
  return items.map((i) => ({ returnItemId: i.id, sellable: i.qty, damaged: 0, missing: 0 }));
}

/**
 * The api's receipt rules (`receiptProblems` in the backend), checked before sending: the three counts of
 * a line add up to its units, and a SKU without a product can only be recorded as not received.
 */
export function receiptLineProblem(
  line: ReceiptLine,
  item: { qty: number; mapped: boolean },
): "total" | "unmapped" | null {
  if (line.sellable + line.damaged + line.missing !== item.qty) return "total";
  if (!item.mapped && line.sellable + line.damaged > 0) return "unmapped";
  return null;
}

export const MAX_EVIDENCE = 9;
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

/** A photo's bytes as the api takes them (`content`, base64 without the data URL prefix). */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Where a return notification leads: its one request, else the tab it is about. */
export function returnNoticeHref(kind: string, data: unknown): string {
  const ids = (data as { returnIds?: unknown } | null)?.returnIds;
  const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  if (list.length === 1) return `/retur?id=${encodeURIComponent(list[0]!)}`;
  return kind === "return.parcel_back" ? "/retur?tab=rto&receive=true" : "/retur?awaiting=true";
}
