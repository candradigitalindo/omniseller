import { describe, expect, it } from "vitest";
import {
  countApplyDelta,
  countEntryProblems,
  receiptLines,
  stockCountNumber,
  stockTransferNumber,
  transferLineProblems,
} from "./stock-ops-plan";

describe("document numbers", () => {
  it("number counts and transfers per month with four digits", () => {
    expect(stockCountNumber("2610", 7)).toBe("OP-2610-0007");
    expect(stockTransferNumber("2610", 12)).toBe("TF-2610-0012");
    expect(stockCountNumber("2701", 12345)).toBe("OP-2701-12345");
  });
});

describe("countApplyDelta", () => {
  it("moves stock by what the count found against the quantity when it was counted", () => {
    expect(countApplyDelta(8, 10, 10)).toBe(-2);
    expect(countApplyDelta(12, 10, 10)).toBe(2);
    expect(countApplyDelta(10, 10, 10)).toBe(0);
  });

  it("keeps what moved between the count and the approval", () => {
    // counted 8 of 10; 3 shipped since: 7 on hand now, 5 after applying
    expect(countApplyDelta(8, 10, 7)).toBe(-2);
    // counted 5 of 5; 4 arrived since: the arrival stays
    expect(countApplyDelta(5, 5, 9)).toBe(0);
    // found 3 not on record (expected 0)
    expect(countApplyDelta(3, 0, 0)).toBe(3);
  });

  it("never takes stock below zero", () => {
    // counted 2 of 10, then 9 shipped: 1 on hand, not -7
    expect(countApplyDelta(2, 10, 1)).toBe(-1);
    expect(countApplyDelta(0, 10, 0)).toBe(0);
    expect(countApplyDelta(0, 4, 4)).toBe(-4);
  });
});

describe("countEntryProblems", () => {
  it("refuses a variant named twice in one request", () => {
    expect(
      countEntryProblems([
        { variantId: "A", qty: 1, mode: "add" },
        { variantId: "B", qty: 2, mode: "set" },
        { variantId: "A", qty: 3, mode: "set" },
      ]),
    ).toEqual([{ path: "lines.2.variantId", message: "SKU ini disebut dua kali." }]);
    expect(countEntryProblems([{ variantId: "A", qty: 1, mode: "add" }])).toEqual([]);
  });
});

describe("transferLineProblems", () => {
  it("needs at least one line, each variant once", () => {
    expect(transferLineProblems([])).toEqual([{ path: "lines", message: "Isi paling sedikit satu SKU." }]);
    expect(
      transferLineProblems([
        { variantId: "A", qty: 1 },
        { variantId: "A", qty: 2 },
      ]),
    ).toEqual([{ path: "lines.1.variantId", message: "SKU ini disebut dua kali." }]);
    expect(transferLineProblems([{ variantId: "A", qty: 1 }])).toEqual([]);
  });
});

describe("receiptLines", () => {
  const lines = [
    { id: "L1", qty: 5 },
    { id: "L2", qty: 3 },
  ];

  it("treats lines left out as received in full", () => {
    const r = receiptLines(lines, [{ lineId: "L2", receivedQty: 1 }]);
    expect(r.problems).toEqual([]);
    expect([...r.received]).toEqual([
      ["L2", 1],
      ["L1", 5],
    ]);
    expect([...receiptLines(lines, []).received]).toEqual([
      ["L1", 5],
      ["L2", 3],
    ]);
  });

  it("allows none to arrive", () => {
    expect(receiptLines(lines, [{ lineId: "L1", receivedQty: 0 }]).received.get("L1")).toBe(0);
  });

  it("refuses unknown lines, lines named twice, and more than was sent", () => {
    const r = receiptLines(lines, [
      { lineId: "X", receivedQty: 1 },
      { lineId: "L1", receivedQty: 6 },
      { lineId: "L2", receivedQty: 3 },
      { lineId: "L2", receivedQty: 2 },
    ]);
    expect(r.problems).toEqual([
      { path: "lines.0.lineId", message: "Baris ini bukan bagian dari transfer." },
      { path: "lines.1.receivedQty", message: "Paling banyak 5, sebanyak yang dikirim." },
      { path: "lines.3.lineId", message: "Baris ini disebut dua kali." },
    ]);
  });
});
