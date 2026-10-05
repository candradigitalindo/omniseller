import { expect, seedShop, tag, test } from "./fixtures";

test("types a manual order: items found by search, the buyer, delivery, and it opens by its number", async ({
  page,
  business,
}) => {
  void business;
  const t = tag();
  await seedShop(page, t);
  await page.goto("/pesanan");
  await page.getByRole("link", { name: "Pesanan manual" }).click();
  await page.waitForURL("/pesanan/baru");

  const search = page.getByLabel("Tambah barang");
  await search.fill(`KAOS-${t}`);
  await page.getByRole("list", { name: "Hasil pencarian" }).getByRole("button", { name: /Putih/ }).click();
  // a full SKU and Enter adds it at once, as a barcode scanner does
  await search.fill(`TMB-${t}-500`);
  await search.press("Enter");
  await expect(page.getByText(`TMB-${t}-500`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Tambah KAOS-${t}-PTH` }).click();

  await page.getByLabel("Nama pembeli").fill("Budi Santoso");
  await page.getByLabel("Telepon pembeli").fill("081298765432");
  await page.getByLabel("Alamat", { exact: true }).fill("Jl. Kenanga No. 7");
  await page.getByLabel("Ongkir").fill("10000");
  // 2 shirts at 65,000, a tumbler at 120,000, and the shipping fee
  await expect(page.getByText("Rp 260.000", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Buat pesanan" }).click();

  await page.waitForURL(/\/pesanan\?id=01/);
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText(/^MN-\d{4}-\d{4}$/).first()).toBeVisible();
  await expect(sheet.getByText("Belum Dibayar")).toBeVisible();
  await expect(sheet.getByText("Jl. Kenanga No. 7")).toBeVisible();
});
