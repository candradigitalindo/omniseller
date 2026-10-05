import { expect, tag, test } from "./fixtures";

test("adds a product by hand, changes a price in place, and finds it in the history", async ({ page, business }) => {
  void business;
  const t = tag();
  await page.goto("/produk");
  await page.getByRole("button", { name: /Tambah produk/ }).click();
  await page.getByRole("menuitem", { name: "Tambah manual" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nama produk").fill("Celana Chino Slim");
  await dialog.getByLabel("SKU induk").fill(`CHINO-${t}`);
  await dialog.getByLabel("SKU varian").fill(`CHINO-${t}-30`);
  await dialog.getByLabel("Nama varian").fill("Krem, 30");
  await dialog.getByLabel("Harga (Rp)").fill("189000");
  await dialog.getByLabel("HPP (Rp)").fill("110000");
  await dialog.getByLabel("Berat (g)").fill("450");
  await dialog.getByRole("button", { name: "Simpan produk" }).click();
  await page.waitForURL(/\/produk\/01/);
  await expect(page.getByRole("heading", { name: "Celana Chino Slim" })).toBeVisible();

  await page.getByRole("tab", { name: "Varian" }).click();
  await page.getByLabel(`Harga (Rp) CHINO-${t}-30`).fill("199000");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByText(`Varian CHINO-${t}-30 disimpan.`)).toBeVisible();

  await page.getByRole("tab", { name: "Riwayat" }).click();
  await expect(page.getByText(/Rp 189\.000 → Rp 199\.000/)).toBeVisible();
});
