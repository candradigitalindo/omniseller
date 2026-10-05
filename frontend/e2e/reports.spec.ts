import { call, expect, seedShop, tag, test } from "./fixtures";

const rupiah = (n: number) => `Rp ${new Intl.NumberFormat("id-ID").format(n)}`;

test("the sales report counts a paid order and breaks it down per product", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  const order = await call<{ total: number }>(page, "GET", `/v1/orders/${shop.order.id}`);

  await page.goto("/laporan/penjualan");
  const kpis = page.getByRole("region", { name: "Angka utama" });
  const tile = (label: string) => kpis.getByText(label, { exact: true }).locator("..");
  // one order: its total is both the revenue and the average order value
  await expect(tile("Omzet").getByText(rupiah(order.total))).toBeVisible();
  await expect(tile("Rata-rata nilai pesanan").getByText(rupiah(order.total))).toBeVisible();
  await expect(tile("Pesanan").getByText("1", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Per produk" }).click();
  await expect(page.getByRole("tabpanel").getByText(`KAOS-${t}-HTM`).first()).toBeVisible();

  // the CSV of the part on screen, with the same period
  const csv = await page.request.get(
    (await page.getByRole("link", { name: "Unduh Per produk sebagai CSV" }).getAttribute("href")) ?? "",
  );
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain(`KAOS-${t}-HTM`);
});

test("the restock list shows stock under its minimum with a suggestion", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  // the tumbler had 10, the order holds 1: 9 left against a minimum of 12
  await call(page, "PUT", `/v1/inventory/${shop.variants.tumbler.id}/warehouses/${shop.warehouseId}`, { minStock: 12 });

  await page.goto("/stok/restock");
  const row = page.getByRole("row", { name: new RegExp(`TMB-${t}-500`) });
  await expect(row.getByText("Di bawah minimum")).toBeVisible();
  // target: the minimum plus one (13), minus the 9 available
  await expect(row.getByRole("cell", { name: "4", exact: true })).toBeVisible();
  // the shirts sell too slowly to need anything until every row is shown
  await expect(page.getByRole("row", { name: new RegExp(`KAOS-${t}-PTH`) })).toHaveCount(0);
  await page.getByRole("button", { name: "Tampilkan semua" }).click();
  await expect(page.getByRole("row", { name: new RegExp(`KAOS-${t}-PTH`) }).getByText("Belum terjual")).toBeVisible();
});
