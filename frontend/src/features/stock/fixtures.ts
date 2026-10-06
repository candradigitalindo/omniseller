import type { Movement } from "./history-meta";

/** Test data of the stock card (L21). */
export const JKT = "01JWAREHOUSE00000000000001";
export const SBY = "01JWAREHOUSE00000000000002";

export function movement(over: Partial<Movement>): Movement {
  return {
    id: "01JMOVE0000000000000000001",
    variantId: "01JVARIANT0000000000000001",
    warehouseId: JKT,
    type: "adjustment",
    onHandDelta: 0,
    reservedDelta: 0,
    damagedDelta: 0,
    bufferDelta: 0,
    onHandAfter: 10,
    reservedAfter: 0,
    damagedAfter: 0,
    bufferAfter: 0,
    availableAfter: 10,
    referenceType: "manual",
    referenceId: null,
    reason: null,
    reasonLabel: null,
    note: null,
    actorUserId: null,
    document: null,
    createdAt: "2026-10-06T03:00:00.000Z",
    ...over,
  };
}
