import type { CountLine, StockCount, Transfer } from "./stock-ops-meta";

export const COUNT_ID = "01JCOUNT000000000000000001";
export const TRANSFER_ID = "01JTRANSFER000000000000001";
export const JAKARTA = { id: "01JWH00000000000000000000A", code: "JKT", name: "Gudang Jakarta" };
export const SURABAYA = { id: "01JWH00000000000000000000B", code: "SBY", name: "Gudang Surabaya" };

export function countFixture(over: Partial<StockCount> = {}): StockCount {
  return {
    id: COUNT_ID,
    number: "OP-2610-0001",
    warehouse: JAKARTA,
    mode: "full",
    blind: true,
    status: "counting",
    statusChangedAt: "2026-10-05T01:00:00.000Z",
    note: null,
    createdBy: null,
    submittedAt: null,
    submittedBy: null,
    applyRequestedAt: null,
    applyRequestedBy: null,
    zeroUncounted: false,
    appliedAt: null,
    stats: { lines: 2, counted: 1, differences: null, added: 0 },
    difference: null,
    rowVersion: 1,
    createdAt: "2026-10-05T01:00:00.000Z",
    updatedAt: "2026-10-05T01:00:00.000Z",
    ...over,
  };
}

export function lineFixture(over: Partial<CountLine> = {}): CountLine {
  return {
    id: "01JCLINE000000000000000001",
    variantId: "01JVARIANT0000000000000001",
    sku: "KAOS-HTM-L",
    productName: "Kaos Polos",
    variantName: "Hitam, L",
    barcode: "8991234567891",
    binLocation: "A-01-02",
    expectedQty: null,
    countedQty: null,
    diff: null,
    reserved: null,
    added: false,
    countedAt: null,
    countedBy: null,
    appliedDelta: null,
    ...over,
  };
}

export function transferFixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: TRANSFER_ID,
    number: "TF-2610-0001",
    from: JAKARTA,
    to: SURABAYA,
    status: "draft",
    statusChangedAt: "2026-10-05T01:00:00.000Z",
    note: null,
    createdBy: null,
    sentAt: null,
    sentBy: null,
    receivedAt: null,
    receivedBy: null,
    receiptNote: null,
    cancelledAt: null,
    cancelledBy: null,
    units: 5,
    lines: [
      {
        id: "01JTLINE000000000000000001",
        variantId: "01JVARIANT0000000000000001",
        sku: "KAOS-HTM-L",
        productName: "Kaos Polos",
        variantName: "Hitam, L",
        qty: 3,
        receivedQty: null,
        missingQty: null,
      },
      {
        id: "01JTLINE000000000000000002",
        variantId: "01JVARIANT0000000000000002",
        sku: "KAOS-PTH-L",
        productName: "Kaos Polos",
        variantName: "Putih, L",
        qty: 2,
        receivedQty: null,
        missingQty: null,
      },
    ],
    rowVersion: 1,
    createdAt: "2026-10-05T01:00:00.000Z",
    updatedAt: "2026-10-05T01:00:00.000Z",
    ...over,
  };
}
