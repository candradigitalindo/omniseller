import { describe, expect, it } from "vitest";
import { retentionCutoff } from "./retention-plan";

describe("buyer data retention (backend doc 8.34)", () => {
  it("goes back whole calendar months, keeping the time of day", () => {
    expect(retentionCutoff(new Date("2026-10-10T07:30:00Z"), 24).toISOString()).toBe("2024-10-10T07:30:00.000Z");
    expect(retentionCutoff(new Date("2026-10-10T07:30:00Z"), 3).toISOString()).toBe("2026-07-10T07:30:00.000Z");
    expect(retentionCutoff(new Date("2026-01-15T00:00:00Z"), 6).toISOString()).toBe("2025-07-15T00:00:00.000Z");
  });

  it("clamps the day to the shorter month, as PostgreSQL does", () => {
    expect(retentionCutoff(new Date("2026-03-31T12:00:00Z"), 1).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(retentionCutoff(new Date("2024-03-31T12:00:00Z"), 1).toISOString()).toBe("2024-02-29T12:00:00.000Z");
    expect(retentionCutoff(new Date("2026-12-31T00:00:00Z"), 3).toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });
});
