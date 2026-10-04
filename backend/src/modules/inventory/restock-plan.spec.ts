import { describe, expect, it } from "vitest";
import { type RestockInput, restockLines } from "./restock-plan";

const row = (over: Partial<RestockInput>): RestockInput => ({
  variantId: "V",
  warehouseId: "W",
  sku: "SKU",
  available: 10,
  minStock: null,
  unitsSold: 0,
  ...over,
});

describe("restock list (FR-STK-07)", () => {
  const opts = { windowDays: 30, coverDays: 14, targetDays: 30 };

  it("measures the daily rate, how long stock lasts, and how much to order", () => {
    const [line] = restockLines([row({ available: 20, unitsSold: 60 })], opts);
    expect(line).toMatchObject({ dailyRate: 2, daysOfCover: 10, suggested: 40, reason: "low_cover" });
  });

  it("leaves alone stock that lasts long enough", () => {
    expect(restockLines([row({ available: 100, unitsSold: 60 })], opts)[0]).toMatchObject({
      daysOfCover: 50,
      suggested: 0,
      reason: null,
    });
  });

  it("flags stock at its minimum even without sales, and orders above the minimum", () => {
    expect(restockLines([row({ available: 5, minStock: 5 })], opts)[0]).toMatchObject({
      dailyRate: 0,
      daysOfCover: null,
      suggested: 1,
      reason: "below_min",
    });
  });

  it("flags stock that ran out while it sells; oversold stock counts as zero", () => {
    expect(restockLines([row({ available: -3, unitsSold: 15 })], opts)[0]).toMatchObject({
      dailyRate: 0.5,
      daysOfCover: 0,
      suggested: 15,
      reason: "out",
    });
    // nothing left, no sales, no minimum: nothing to say
    expect(restockLines([row({ available: 0 })], opts)[0]?.reason).toBeNull();
  });

  it("puts what is most urgent first", () => {
    const lines = restockLines(
      [
        row({ sku: "C", available: 30, unitsSold: 60 }),
        row({ sku: "A", available: 0, unitsSold: 6 }),
        row({ sku: "B", available: 2, minStock: 3 }),
        row({ sku: "D", available: 5, unitsSold: 60 }),
        row({ sku: "E", available: 500, unitsSold: 3 }),
      ],
      opts,
    );
    expect(lines.map((l) => [l.sku, l.reason])).toEqual([
      ["A", "out"],
      ["B", "below_min"],
      ["D", "low_cover"],
      ["C", null],
      ["E", null],
    ]);
  });

  it("follows the window and the target", () => {
    expect(
      restockLines([row({ available: 4, unitsSold: 14 })], { windowDays: 7, coverDays: 7, targetDays: 14 })[0],
    ).toMatchObject({
      dailyRate: 2,
      daysOfCover: 2,
      suggested: 24,
      reason: "low_cover",
    });
  });
});
