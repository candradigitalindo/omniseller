import { describe, expect, it } from "vitest";
import { confirmsName, PURGE_AFTER_DAYS, PURGE_REMINDER_DAYS, purgeDate, reminderDue } from "./closure-plan";

const at = (iso: string) => new Date(iso);

describe("account closure rules (backend doc 8.36)", () => {
  it("deletes the data 30 days after the closure, to the millisecond", () => {
    expect(PURGE_AFTER_DAYS).toBe(30);
    expect(purgeDate(at("2026-10-10T03:04:05.006Z")).toISOString()).toBe("2026-11-09T03:04:05.006Z");
  });

  it("reminds from 7 days before the deletion until it happens", () => {
    expect(PURGE_REMINDER_DAYS).toBe(7);
    const purge = at("2026-11-09T03:00:00.000Z");
    expect(reminderDue(purge, at("2026-11-02T02:59:59.999Z"))).toBe(false);
    expect(reminderDue(purge, at("2026-11-02T03:00:00.000Z"))).toBe(true);
    expect(reminderDue(purge, at("2026-11-09T02:59:59.999Z"))).toBe(true);
    expect(reminderDue(purge, at("2026-11-09T03:00:00.000Z"))).toBe(false);
  });

  it("takes the business's name typed again whatever the case and spacing, and nothing else", () => {
    expect(confirmsName("toko  rina   jaya", "Toko Rina Jaya")).toBe(true);
    expect(confirmsName(" TOKO RINA JAYA ", "Toko Rina Jaya")).toBe(true);
    expect(confirmsName("Toko Rina", "Toko Rina Jaya")).toBe(false);
    expect(confirmsName("Toko Rina Jaya!", "Toko Rina Jaya")).toBe(false);
    // full-width letters a phone keyboard may give are the same letters
    expect(confirmsName("ＴＯＫＯ", "Toko")).toBe(true);
    expect(confirmsName("", "")).toBe(false);
    expect(confirmsName("   ", "   ")).toBe(false);
  });
});
