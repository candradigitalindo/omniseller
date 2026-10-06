import AxeBuilder from "@axe-core/playwright";
import { expect, seedShop, tag, test } from "./fixtures";

/** Pages a seller opens every day, checked with axe for WCAG 2 A and AA problems (DOKUMEN-UI-UX 10). */
const PAGES = [
  "/",
  "/pesanan",
  "/pesanan/baru",
  "/pengiriman",
  "/retur",
  "/produk",
  "/listing",
  "/listing/salin",
  "/stok",
  "/stok/opname",
  "/stok/transfer",
  "/stok/restock",
  "/stok/riwayat",
  "/laporan/penjualan",
  "/stok/gudang",
  "/integrasi",
  "/tim",
  "/printer",
  "/notifikasi",
  "/migrasi",
  "/ekspor",
];

test("the daily pages have no serious accessibility problems", async ({ page, business }) => {
  void business;
  const shop = await seedShop(page, tag());
  // a stock card with movements, besides the empty one in the list
  const card = `/stok/riwayat?variant=${shop.variants.black.id}&sku=${encodeURIComponent(shop.variants.black.sku)}`;
  const found: string[] = [];
  for (const path of [...PAGES, card, `/integrasi/${shop.storeId}`]) {
    await page.goto(path);
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    await page.waitForLoadState("networkidle");
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    for (const v of result.violations) {
      if (v.impact === "serious" || v.impact === "critical") {
        found.push(
          `${path}: ${v.id} (${v.impact}) ${v.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 3)
            .join(", ")}`,
        );
      }
    }
  }
  expect(found).toEqual([]);
});
