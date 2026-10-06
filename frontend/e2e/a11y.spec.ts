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
  await seedShop(page, tag());
  const found: string[] = [];
  for (const path of PAGES) {
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
