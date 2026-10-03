import { describe, expect, it } from "vitest";
import { isoInZone, localDate, startOfDate } from "./time-zone";

describe("time zone helpers", () => {
  it("knows where a day starts in Jakarta and which day an instant falls on", () => {
    expect(startOfDate("Asia/Jakarta", "2026-10-03").toISOString()).toBe("2026-10-02T17:00:00.000Z");
    expect(localDate("Asia/Jakarta", new Date("2026-10-02T16:59:59Z"))).toBe("2026-10-02");
    expect(localDate("Asia/Jakarta", new Date("2026-10-02T17:00:00Z"))).toBe("2026-10-03");
  });

  it("follows zones that change offset (daylight saving)", () => {
    // New York: -5 until 2026-03-08 02:00, -4 until 2026-11-01 02:00, then -5 again
    expect(startOfDate("America/New_York", "2026-03-08").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(startOfDate("America/New_York", "2026-03-09").toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(startOfDate("America/New_York", "2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(startOfDate("America/New_York", "2026-11-02").toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(isoInZone("America/New_York", new Date("2026-11-01T12:00:00Z"))).toBe("2026-11-01T07:00:00-05:00");
  });

  it("writes ISO 8601 local time with the offset, to the second", () => {
    expect(isoInZone("Asia/Jakarta", new Date("2026-10-03T07:15:09.500Z"))).toBe("2026-10-03T14:15:09+07:00");
    expect(isoInZone("Asia/Makassar", new Date("2026-10-03T16:00:00Z"))).toBe("2026-10-04T00:00:00+08:00");
    expect(isoInZone("Asia/Kolkata", new Date("2026-10-03T00:00:00Z"))).toBe("2026-10-03T05:30:00+05:30");
    expect(isoInZone("UTC", new Date("2026-10-03T00:00:00Z"))).toBe("2026-10-03T00:00:00+00:00");
  });
});
