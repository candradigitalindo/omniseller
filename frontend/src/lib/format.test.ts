import { describe, expect, it } from "vitest";
import {
  firstName,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercentChange,
  formatRelative,
  formatRemaining,
  formatRupiah,
  formatTime,
  greeting,
} from "./format";

const JKT = "Asia/Jakarta";

describe("money and numbers (DOKUMEN-UI-UX 5)", () => {
  it("writes rupiah with a space, dots for thousands, and no decimals", () => {
    expect(formatRupiah(1_250_000)).toBe("Rp 1.250.000");
    expect(formatRupiah(0)).toBe("Rp 0");
    expect(formatRupiah(-20_000)).toBe("-Rp 20.000");
    expect(formatNumber(12_345)).toBe("12.345");
  });

  it("signs percentage changes and keeps one decimal only for small ones", () => {
    expect(formatPercentChange(12.4)).toBe("+12%");
    expect(formatPercentChange(-3.46)).toBe("-3,5%");
    expect(formatPercentChange(0)).toBe("0%");
  });
});

describe("times in the business's time zone", () => {
  const at = "2026-09-30T07:05:00Z";

  it("writes the date and time the Indonesian way", () => {
    expect(formatDateTime(at, JKT)).toBe("30 Sep 2026, 14.05");
    expect(formatDate(at, JKT)).toBe("30 Sep 2026");
    expect(formatTime(at, JKT)).toBe("14.05");
    expect(formatDateTime(at, "Asia/Makassar")).toBe("30 Sep 2026, 15.05");
  });

  it("says how long ago something happened, then falls back to the date", () => {
    const now = new Date("2026-09-30T10:00:00Z");
    expect(formatRelative("2026-09-30T09:59:40Z", JKT, now)).toBe("baru saja");
    expect(formatRelative("2026-09-30T09:55:00Z", JKT, now)).toBe("5 menit lalu");
    expect(formatRelative("2026-09-30T07:00:00Z", JKT, now)).toBe("3 jam lalu");
    expect(formatRelative("2026-09-29T08:00:00Z", JKT, now)).toBe("kemarin");
    expect(formatRelative("2026-09-26T10:00:00Z", JKT, now)).toBe("4 hari lalu");
    expect(formatRelative("2026-09-01T10:00:00Z", JKT, now)).toBe("1 Sep 2026, 17.00");
  });

  it("counts down to a deadline and past it", () => {
    expect(formatRemaining((2 * 60 + 15) * 60_000)).toBe("2 jam 15 menit lagi");
    expect(formatRemaining(45 * 60_000)).toBe("45 menit lagi");
    expect(formatRemaining(3 * 60 * 60_000)).toBe("3 jam lagi");
    expect(formatRemaining(-(65 * 60_000))).toBe("lewat 1 jam 5 menit");
    expect(formatRemaining((26 * 60 + 30) * 60_000)).toBe("1 hari 2 jam lagi");
  });

  it("greets by the hour where the business is", () => {
    expect(greeting(JKT, new Date("2026-09-30T00:30:00Z"))).toBe("Selamat pagi");
    expect(greeting(JKT, new Date("2026-09-30T05:00:00Z"))).toBe("Selamat siang");
    expect(greeting(JKT, new Date("2026-09-30T09:00:00Z"))).toBe("Selamat sore");
    expect(greeting(JKT, new Date("2026-09-30T13:00:00Z"))).toBe("Selamat malam");
    expect(firstName("  Rina Wulandari ")).toBe("Rina");
  });
});
