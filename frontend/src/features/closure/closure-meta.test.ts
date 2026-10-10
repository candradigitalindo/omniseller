import { describe, expect, it } from "vitest";
import { daysLeft, namesMatch } from "./closure-meta";

describe("account closure (backend doc 8.36)", () => {
  it("counts whole days until the data goes, never below zero", () => {
    const now = new Date("2026-10-10T00:00:00.000Z");
    expect(daysLeft("2026-11-09T00:00:00.000Z", now)).toBe(30);
    expect(daysLeft("2026-10-10T00:00:00.001Z", now)).toBe(1);
    expect(daysLeft("2026-10-10T00:00:00.000Z", now)).toBe(0);
    expect(daysLeft("2026-10-01T00:00:00.000Z", now)).toBe(0);
  });

  it("takes the business's name typed again as the api does", () => {
    expect(namesMatch("  toko   RINA ", "Toko Rina")).toBe(true);
    expect(namesMatch("Toko Rin", "Toko Rina")).toBe(false);
    expect(namesMatch("", "")).toBe(false);
  });
});
