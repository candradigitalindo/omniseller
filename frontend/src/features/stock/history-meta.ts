import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";
import type { Permission } from "@/lib/session";

export type Movement = components["schemas"]["MovementPageDto_Output"]["items"][number];
export type MovementType = Movement["type"];
export type MovementDocument = NonNullable<Movement["document"]>;

/** Movement kinds as the seller says them; colors follow the direction stock moves (L21). */
export const MOVEMENT_TONE: Record<MovementType, Tone> = {
  order_reserve: "info",
  order_release: "neutral",
  order_ship: "info",
  return_restock: "success",
  return_quarantine: "warning",
  adjustment: "neutral",
  count_apply: "neutral",
  transfer_out: "warning",
  transfer_in: "success",
  purchase_receipt: "success",
  quarantine_in: "warning",
  quarantine_out: "neutral",
  campaign_hold: "promo",
  campaign_release: "promo",
  migration_initial: "neutral",
};

export const MOVEMENT_TYPES = Object.keys(MOVEMENT_TONE) as MovementType[];

export function movementTypeOf(value: string | null): MovementType | null {
  return MOVEMENT_TYPES.find((t) => t === value) ?? null;
}

/** The changes a movement made, the ones that are not zero: on hand, reserved, damaged, buffer. */
export function changes(m: Movement): { part: "onHand" | "reserved" | "damaged" | "buffer"; delta: number }[] {
  const all = [
    { part: "onHand" as const, delta: m.onHandDelta },
    { part: "reserved" as const, delta: m.reservedDelta },
    { part: "damaged" as const, delta: m.damagedDelta },
    { part: "buffer" as const, delta: m.bufferDelta },
  ];
  return all.filter((c) => c.delta !== 0);
}

/** "+2", "-3", "0". */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** Who moved it: the system (orders, marketplace), the viewer, or another person. */
export function actorKind(actorUserId: string | null, me: string): "system" | "you" | "other" {
  if (actorUserId === null) return "system";
  return actorUserId === me ? "you" : "other";
}

/**
 * Ready-to-sell stock over time from the loaded movements, oldest first, one point per movement of one
 * warehouse (the movements of several warehouses do not add up into one line).
 */
export function availableSeries(movements: readonly Movement[], warehouseId: string): { at: string; value: number }[] {
  return movements
    .filter((m) => m.warehouseId === warehouseId)
    .map((m) => ({ at: m.createdAt, value: m.availableAfter }))
    .reverse();
}

/**
 * Where a movement's document opens, when the viewer may open it: orders and returns in their lists' detail,
 * a stock count on its page, a transfer in the transfer list. Null: the number is shown as text.
 */
export function documentHref(doc: MovementDocument, can: (p: Permission) => boolean): string | null {
  switch (doc.type) {
    case "order":
      return can("order:read") ? `/pesanan?id=${doc.id}` : null;
    case "return":
      return can("order:read") ? `/retur?id=${doc.id}` : null;
    case "stock_count":
      return can("inventory:count") ? `/stok/opname/${doc.id}` : null;
    case "stock_transfer":
      return can("inventory:transfer") ? `/stok/transfer?id=${doc.id}` : null;
  }
}

/** The note worth showing: the ones the api writes ("Transfer TF-…") only repeat the document beside them. */
export function noteFor(m: Pick<Movement, "note" | "document">): string | null {
  if (!m.note) return null;
  return m.document && m.note.includes(m.document.number) ? null : m.note;
}

/**
 * The small line's geometry in a `width` x `height` box: one step of equal width per movement, oldest first,
 * y from the lowest of zero and the values to the highest with 4 units of air above and below. Not a time axis:
 * movements come in bursts, and by time an hour of orders shares one pixel while the last value gets no width
 * to point at. The readout and the table give each movement's time.
 */
export function sparkGeometry(
  points: readonly { value: number }[],
  width: number,
  height: number,
): { band: number; ys: number[]; zeroY: number; d: string } {
  const band = width / points.length;
  const values = points.map((p) => p.value);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const y = (v: number) => height - 4 - ((v - min) / (max - min)) * (height - 8);
  const ys = values.map(y);
  const d = ys.map((v, i) => `${i === 0 ? `M0,${v}` : `V${v}`}H${(i + 1) * band}`).join("");
  return { band, ys, zeroY: y(0), d };
}

/** The movement whose step is under `x`. */
export function pointAt(band: number, count: number, x: number): number {
  return Math.min(Math.max(Math.floor(x / band), 0), count - 1);
}
