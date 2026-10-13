import { describe, expect, it } from "vitest";
import { toCsv } from "../../common/csv";
import { toXlsx } from "../../common/xlsx";
import { readXlsx, readXlsxAll, xmlText } from "../migration/xlsx";
import {
  OTHER_REGION,
  regionRows,
  SALES_SECTIONS,
  SALES_SHEET_NAMES,
  type SalesReport,
  salesSectionRows,
  salesSheets,
  salesSummaryRows,
  sheetOf,
} from "./sales-report.service";
import { staffCsvRows, staffDayRows, staffSummaryRows } from "./staff-report-plan";

const totals = (n: number) => ({
  revenue: 100_000 * n,
  orders: 2 * n,
  units: 3 * n,
  averageOrderValue: 50_000,
  paidOrders: 2 * n,
  cancelledOrders: n - 1,
  cancellationRate: n === 1 ? 0 : 33.3,
  shippedOrders: n,
  shippedRevenue: 40_000 * n,
});

/** A report as `SalesReportService.report` returns it, with one row per section. */
const report = (previous: boolean): SalesReport =>
  ({
    timezone: "Asia/Jakarta",
    range: { from: "2026-10-01", to: "2026-10-31" },
    granularity: "day",
    period: { from: new Date("2026-09-30T17:00:00Z"), to: new Date("2026-10-31T17:00:00Z") },
    previousRange: previous ? { from: "2026-09-01", to: "2026-09-30" } : null,
    previousPeriod: null,
    summary: { ...totals(2), previous: previous ? totals(1) : null, change: null },
    series: [{ bucket: "2026-10-01", orders: 2, revenue: 200_000, previousOrders: 1, previousRevenue: 100_000 }],
    byChannel: [{ channel: "shopee", displayName: "Shopee", orders: 2, revenue: 200_000, share: 100 }],
    byStore: [
      {
        storeId: "S1",
        name: "Toko A",
        channel: "shopee",
        displayName: "Shopee",
        orders: 2,
        revenue: 200_000,
        share: 100,
      },
    ],
    byProduct: [
      { variantId: "V1", sku: "KAOS-M", name: "Kaos & Polos", variantName: "M", units: 3, orders: 2, revenue: 200_000 },
    ],
    byCategory: [{ category: null, units: 3, orders: 2, revenue: 200_000 }],
    byRegion: [{ province: null, orders: 2, revenue: 200_000, share: 100 }],
    byHour: [{ weekday: 1, hour: 9, orders: 2, revenue: 200_000 }],
  }) as unknown as SalesReport;

describe("sales report sheets", () => {
  it("gives every section the CSV's rows, as its own sheet, after a summary", () => {
    const r = report(true);
    const sheets = salesSheets(r);
    expect(sheets.map((s) => s.name)).toEqual([
      "Ringkasan",
      "Per periode",
      "Per kanal",
      "Per toko",
      "Per produk",
      "Per kategori",
      "Per wilayah",
      "Per jam",
    ]);
    for (const section of SALES_SECTIONS) {
      const rows = salesSectionRows(r, section);
      const sheet = sheets.find((s) => s.name === SALES_SHEET_NAMES[section])!;
      expect(sheet.columns).toEqual(rows[0]);
      expect(sheet.rows).toEqual(rows.slice(1));
      // the CSV of the section is the same table
      expect(toCsv(rows).split("\r\n")[0]).toBe(`﻿${rows[0]!.join(";")}`);
    }
    // what the reader of the workbook sees on the first sheet
    const read = readXlsx(toXlsx(sheets, { timeZone: r.timezone }), 50).rows;
    expect(read[0]).toEqual(["Ukuran", "Periode ini", "Periode sebelumnya"]);
    expect(read[1]).toEqual(["Periode", "2026-10-01 s.d. 2026-10-31", "2026-09-01 s.d. 2026-09-30"]);
    expect(read[2]).toEqual(["Omzet", "200000", "100000"]);
    expect(read[8]).toEqual(["Tingkat pembatalan (%)", "33.3", "0"]);
  });

  it("summarizes without a comparison when the report has none", () => {
    const rows = salesSummaryRows(report(false));
    expect(rows[0]).toEqual(["Ukuran", "Periode ini", "Periode sebelumnya"]);
    expect(rows[1]).toEqual(["Periode", "2026-10-01 s.d. 2026-10-31", null]);
    expect(rows.slice(2).every((r) => r[2] === null)).toBe(true);
    expect(rows.map((r) => r[0])).toEqual([
      "Ukuran",
      "Periode",
      "Omzet",
      "Pesanan",
      "Unit",
      "Rata-rata nilai pesanan",
      "Pesanan dibayar",
      "Pesanan dibatalkan",
      "Tingkat pembatalan (%)",
      "Diserahkan ke kurir",
      "Omzet diserahkan",
    ]);
  });

  it("keeps the product name's characters through the workbook", () => {
    const sheet = sheetOf("Per produk", salesSectionRows(report(false), "products"));
    const bytes = toXlsx([sheet]);
    expect(readXlsx(bytes, 5).rows[1]).toEqual(["KAOS-M", "Kaos & Polos", "M", "3", "2", "200000"]);
    expect(xmlText("Kaos &amp; Polos")).toBe("Kaos & Polos");
  });
});

describe("regions and the team's sheets", () => {
  it("names provinces as OmniSeller does, folds the rest into Lainnya, and keeps the unknown apart", () => {
    const rows = regionRows(
      [
        { label: "DKI Jakarta", orders: 3, revenue: 300_000 },
        { label: "jakarta", orders: 1, revenue: 100_000 },
        { label: "Jl. Mawar 5, Bandung", orders: 2, revenue: 50_000 },
        { label: "Budi Santoso", orders: 1, revenue: 10_000 },
        { label: null, orders: 1, revenue: 20_000 },
      ],
      480_000,
    );
    expect(rows).toEqual([
      { province: "DKI Jakarta", orders: 4, revenue: 400_000, share: expect.any(Number) },
      { province: OTHER_REGION, orders: 3, revenue: 60_000, share: expect.any(Number) },
      { province: null, orders: 1, revenue: 20_000, share: expect.any(Number) },
    ]);
    expect(rows[0]!.share).toBeCloseTo(83.3, 0);
    expect(salesSectionRows({ ...report(false), byRegion: rows } as SalesReport, "regions")[3]).toEqual([
      "Tidak diketahui",
      1,
      20_000,
      expect.any(Number),
    ]);
  });

  it("gives the team report a summary and the team per day beside the two CSV tables", () => {
    const figures = {
      processed: 8,
      packed: 3,
      packedByScan: 2,
      labels: 4,
      pickLists: 3,
      packingLists: 4,
      handedOver: 3,
      timedPacks: 1,
      packSecondsAverage: 95,
    };
    const r = {
      timezone: "Asia/Jakarta",
      range: { from: "2026-10-01", to: "2026-10-31" },
      packTimeLimitSeconds: 1800,
      total: figures,
      users: [{ userId: "U1", name: "Rina", ...figures }],
      days: [{ date: "2026-10-02", ...figures }],
      userDays: [{ userId: "U1", date: "2026-10-02", ...figures }],
    };
    expect(staffSummaryRows(r).slice(0, 3)).toEqual([
      ["Ukuran", "Nilai"],
      ["Periode", "2026-10-01 s.d. 2026-10-31"],
      ["Pesanan diproses", 8],
    ]);
    expect(staffSummaryRows(r).at(-1)).toEqual(["Batas detik kemas yang dihitung", 1800]);
    expect(staffDayRows(r)).toEqual([
      [
        "tanggal",
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
      ["2026-10-02", 8, 3, 2, 4, 3, 4, 3, 1, 95],
    ]);
    const sheets = readXlsxAll(
      toXlsx([
        sheetOf("Ringkasan", staffSummaryRows(r)),
        sheetOf("Per anggota", staffCsvRows(r, "users")),
        sheetOf("Per anggota per hari", staffCsvRows(r, "days")),
        sheetOf("Per hari", staffDayRows(r)),
      ]),
      10,
    );
    expect(sheets.map((s) => s.name)).toEqual(["Ringkasan", "Per anggota", "Per anggota per hari", "Per hari"]);
    expect(sheets[1]!.rows[1]).toEqual(["Rina", "8", "3", "2", "4", "3", "4", "3", "1", "95"]);
    expect(sheets[3]!.rows[1]![0]).toBe("2026-10-02");
  });
});
