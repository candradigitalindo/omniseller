import { describe, expect, it } from "vitest";
import type { StaffActionRow } from "../orders/orders.repository";
import { figuresOf, NO_FIGURES, staffCsvRows, staffReport, UNKNOWN_MEMBER } from "./staff-report-plan";

const row = (userId: string | null, day: string | null, over: Partial<StaffActionRow> = {}): StaffActionRow => ({
  userId,
  day,
  processed: 0,
  packed: 0,
  packedByScan: 0,
  labels: 0,
  pickLists: 0,
  packingLists: 0,
  handedOver: 0,
  timedPacks: 0,
  packSeconds: 0,
  ...over,
});

describe("figuresOf", () => {
  it("averages the timed packs to whole seconds, and has no average without any", () => {
    expect(figuresOf(row("u", null, { packed: 3, timedPacks: 2, packSeconds: 125 })).packSecondsAverage).toBe(63);
    expect(figuresOf(row("u", null, { packed: 3 })).packSecondsAverage).toBeNull();
  });

  it("carries every count as the orders module counted it", () => {
    const r = row("u", "2026-10-01", {
      processed: 9,
      packed: 8,
      packedByScan: 7,
      labels: 6,
      pickLists: 5,
      packingLists: 4,
      handedOver: 3,
      timedPacks: 2,
      packSeconds: 90,
    });
    expect(figuresOf(r)).toEqual({
      processed: 9,
      packed: 8,
      packedByScan: 7,
      labels: 6,
      pickLists: 5,
      packingLists: 4,
      handedOver: 3,
      timedPacks: 2,
      packSecondsAverage: 45,
    });
  });
});

describe("staffReport", () => {
  const names = new Map([
    ["u1", "Budi"],
    ["u2", "Andi"],
    ["u3", "Sari"],
  ]);

  it("sorts each grouping set into the team total, members, days, and members' days", () => {
    const r = staffReport(
      [
        row("u1", "2026-10-02", { processed: 2 }),
        row("u1", null, { processed: 3 }),
        row(null, "2026-10-02", { processed: 4 }),
        row(null, null, { processed: 5 }),
        row("u1", "2026-10-01", { processed: 1 }),
        row(null, "2026-10-01", { processed: 1 }),
      ],
      names,
    );
    expect(r.total.processed).toBe(5);
    expect(r.users).toEqual([{ userId: "u1", name: "Budi", ...figuresOf(row("u1", null, { processed: 3 })) }]);
    expect(r.days.map((d) => [d.date, d.processed])).toEqual([
      ["2026-10-01", 1],
      ["2026-10-02", 4],
    ]);
    expect(r.userDays.map((d) => [d.date, d.userId, d.processed])).toEqual([
      ["2026-10-01", "u1", 1],
      ["2026-10-02", "u1", 2],
    ]);
  });

  it("ranks members by orders processed, then packed, then name; a day lists them in that order", () => {
    const r = staffReport(
      [
        row("u3", null, { processed: 4, packed: 2 }),
        row("u1", null, { processed: 4, packed: 1 }),
        row("u2", null, { processed: 4, packed: 1 }),
        row("u4", null, { processed: 9 }),
        row("u3", "2026-10-01"),
        row("u4", "2026-10-01"),
        row("u2", "2026-10-01"),
        row(null, null),
      ],
      names,
    );
    // Sari packed more than Andi and Budi, who tie and go by name
    expect(r.users.map((u) => u.userId)).toEqual(["u4", "u3", "u2", "u1"]);
    expect(r.userDays.map((d) => d.userId)).toEqual(["u4", "u3", "u2"]);
    // someone who left the business keeps their figures without a name
    expect(r.users[0]?.name).toBeNull();
  });

  it("has an empty team when nobody did anything", () => {
    expect(staffReport([row(null, null)], names)).toEqual({ total: NO_FIGURES, users: [], days: [], userDays: [] });
  });
});

describe("staffCsvRows", () => {
  const report = staffReport(
    [
      row("u1", null, { processed: 3, packed: 2, packedByScan: 1, labels: 4, timedPacks: 1, packSeconds: 70 }),
      row("gone", null, { processed: 1 }),
      row("u1", "2026-10-01", { processed: 3, packed: 2, packedByScan: 1, labels: 4, timedPacks: 1, packSeconds: 70 }),
      row("gone", "2026-10-02", { processed: 1 }),
    ],
    new Map([["u1", "Budi"]]),
  );

  it("writes one row per member with the figures in the header's order", () => {
    expect(staffCsvRows(report, "users")).toEqual([
      [
        "nama",
        "pesanan_diproses",
        "dikemas",
        "dikemas_dengan_scan",
        "label_dicetak",
        "pesanan_di_pick_list",
        "daftar_kemas_dicetak",
        "diserahkan_ke_kurir",
        "kemas_berwaktu",
        "rata_rata_detik_kemas",
      ],
      ["Budi", 3, 2, 1, 4, 0, 0, 0, 1, 70],
      [UNKNOWN_MEMBER, 1, 0, 0, 0, 0, 0, 0, 0, null],
    ]);
  });

  it("writes one row per member and day, dated", () => {
    const rows = staffCsvRows(report, "days");
    expect(rows[0]?.slice(0, 3)).toEqual(["tanggal", "nama", "pesanan_diproses"]);
    expect(rows.slice(1)).toEqual([
      ["2026-10-01", "Budi", 3, 2, 1, 4, 0, 0, 0, 1, 70],
      ["2026-10-02", UNKNOWN_MEMBER, 1, 0, 0, 0, 0, 0, 0, 0, null],
    ]);
  });
});
