import { describe, expect, it } from "vitest";
import { orderChannel, orderDate, orderPeriod } from "./order-filters";

describe("order filters", () => {
  it("accepts supported channels and real calendar dates from shared links", () => {
    expect(orderChannel("manual")).toBe("manual");
    expect(orderChannel("unknown")).toBeNull();
    expect(orderDate("2024-02-29")).toBe("2024-02-29");
    for (const invalid of [null, "2026-02-29", "2026-13-01", "2026-2-01", "0000-01-01", "9999-12-31"]) {
      expect(orderDate(invalid)).toBeNull();
    }
  });

  it("includes the last selected calendar day in the business's time zone", () => {
    expect(orderPeriod("2026-10-01", "2026-10-02", "Asia/Jayapura")).toEqual({
      from: "2026-09-30T15:00:00.000Z",
      to: "2026-10-02T15:00:00.000Z",
    });
    expect(orderPeriod(null, "2024-02-29", "Asia/Jakarta")).toEqual({
      from: undefined,
      to: "2024-02-29T17:00:00.000Z",
    });
    expect(orderPeriod("2026-12-31", null, "Asia/Makassar")).toEqual({
      from: "2026-12-30T16:00:00.000Z",
      to: undefined,
    });
    expect(orderPeriod(null, null, "Asia/Jakarta")).toEqual({ from: undefined, to: undefined });
  });

  it("uses two local midnights across a clock change, rather than adding 24 hours to an instant", () => {
    expect(orderPeriod("2026-03-08", "2026-03-08", "America/New_York")).toEqual({
      from: "2026-03-08T05:00:00.000Z",
      to: "2026-03-09T04:00:00.000Z",
    });
  });
});
