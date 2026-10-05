import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countedPercent, lineFilters, receiptLines, ScanBuffer, transferSides } from "./stock-ops-meta";

describe("ScanBuffer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends scans of one code as one request once scanning pauses", () => {
    const send = vi.fn();
    const buffer = new ScanBuffer(send, 700);
    buffer.add("8991234567891");
    vi.advanceTimersByTime(500);
    buffer.add("8991234567891");
    vi.advanceTimersByTime(500);
    buffer.add("8991234567891", 2);
    expect(buffer.pending).toEqual({ code: "8991234567891", qty: 4 });
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(700);
    expect(send).toHaveBeenCalledExactlyOnceWith("8991234567891", 4);
    expect(buffer.pending).toBeNull();
  });

  it("sends what waits as soon as another code is scanned, or when asked", () => {
    const send = vi.fn();
    const buffer = new ScanBuffer(send, 700);
    buffer.add("A");
    buffer.add("A");
    buffer.add("B");
    expect(send).toHaveBeenCalledExactlyOnceWith("A", 2);
    buffer.flush();
    expect(send).toHaveBeenLastCalledWith("B", 1);
    buffer.flush();
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("stock operation rules", () => {
  it("shows progress and keeps differences hidden while a blind count is counted", () => {
    expect(countedPercent({ lines: 3, counted: 2 })).toBe(66);
    expect(countedPercent({ lines: 0, counted: 0 })).toBe(0);
    expect(lineFilters({ blind: true, status: "counting" })).not.toContain("differences");
    expect(lineFilters({ blind: true, status: "review" })).toContain("differences");
    expect(lineFilters({ blind: false, status: "counting" })).toContain("differences");
  });

  it("puts the user on the side of the warehouses in their scope", () => {
    const t = { from: { id: "jkt", code: "JKT", name: "Jakarta" }, to: { id: "sby", code: "SBY", name: "Surabaya" } };
    expect(transferSides(t, null)).toEqual({ origin: true, destination: true });
    expect(transferSides(t, ["sby"])).toEqual({ origin: false, destination: true });
    expect(transferSides(t, [])).toEqual({ origin: false, destination: false });
  });

  it("lists only lines that did not arrive in full", () => {
    const lines = [
      { id: "l1", qty: 5 },
      { id: "l2", qty: 3 },
      { id: "l3", qty: 2 },
    ];
    expect(receiptLines(lines, { l1: 5, l2: 1 })).toEqual([{ lineId: "l2", receivedQty: 1 }]);
    expect(receiptLines(lines, {})).toEqual([]);
  });
});
