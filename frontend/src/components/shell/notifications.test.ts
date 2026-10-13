import { describe, expect, it } from "vitest";
import { noticeHref } from "./notifications";

describe("noticeHref", () => {
  it("opens the list a notification is about", () => {
    expect(noticeHref({ kind: "order.new", data: {} })).toBe("/pesanan?status=new");
    // an NIB deadline or a document running out (backend doc 8.29)
    expect(noticeHref({ kind: "legal.reminder", data: { type: "nib_deadline" } })).toBe("/profil-bisnis");
    expect(noticeHref({ kind: "order.sla", data: {} })).toBe("/pesanan?due=soon");
    expect(noticeHref({ kind: "store.reauth", data: {} })).toBeNull();
    // an emailed report opens its screen on the period it covered (backend doc 8.20)
    expect(noticeHref({ kind: "report.sales_weekly", data: { from: "2026-10-05", to: "2026-10-11" } })).toBe(
      "/laporan/penjualan?period=custom&from=2026-10-05&to=2026-10-11",
    );
    expect(noticeHref({ kind: "report.staff_monthly", data: { from: "2026-09-01", to: "2026-09-30" } })).toBe(
      "/laporan/kinerja-tim?period=custom&from=2026-09-01&to=2026-09-30",
    );
    expect(noticeHref({ kind: "report.sales_monthly", data: { from: "x" } })).toBe("/laporan/penjualan");
  });

  it("opens a stock alert on its SKU when it names one", () => {
    const one = { items: [{ variantId: "v1", sku: "TMB-500", warehouseId: "w1", level: "out", available: 0 }] };
    expect(noticeHref({ kind: "stock.critical", data: one })).toBe("/stok?q=TMB-500");
    const two = { items: [{ sku: "A" }, { sku: "B" }] };
    expect(noticeHref({ kind: "stock.critical", data: two })).toBe("/stok");
    expect(noticeHref({ kind: "stock.critical", data: { items: "nonsense" } })).toBe("/stok");
  });
});
