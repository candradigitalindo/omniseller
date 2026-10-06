import { call, expect, tag, test } from "./fixtures";

test("imports products from another app's export after checking every row", async ({ page, business }) => {
  void business;
  const t = tag();
  // a BigSeller-like export with a title row above the header, as some apps write it
  const csv = [
    "Ekspor Produk BigSeller",
    "Judul;Nomor SKU;Harga Jual;Harga Modal;Berat (gram);Stok",
    `Kemeja Batik ${t};MIG-${t}-S;Rp 65.000;35.000;300;5`,
    `Kemeja Batik ${t};MIG-${t}-M;Rp 65.000;35.000;300;6`,
  ].join("\r\n");
  await page.goto("/migrasi");
  await page.getByText("BigSeller", { exact: true }).click();
  await page
    .getByLabel("Berkas ekspor")
    .setInputFiles({ name: "ekspor.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Unggah dan petakan kolom" }).click();
  await page.waitForURL(/job=01/);

  // the header is found on row 2 and the columns guessed from their names
  await expect(page.getByLabel("Baris judul")).toHaveValue("2");
  await expect(page.getByRole("combobox", { name: /SKU varian/ })).toHaveText("B · Nomor SKU");
  await page.getByRole("button", { name: "Periksa berkas" }).click();
  await expect(page.getByText("Berkas siap diimpor")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Impor sekarang" }).click();
  await expect(page.getByText("Impor selesai")).toBeVisible({ timeout: 30_000 });

  const found = await call<{ items: { variants: { sku: string; basePrice: number }[] }[] }>(
    page,
    "GET",
    `/v1/products?q=MIG-${t}`,
  );
  expect(found.items.flatMap((p) => p.variants.map((v) => [v.sku, v.basePrice]))).toEqual(
    expect.arrayContaining([
      [`MIG-${t}-S`, 65_000],
      [`MIG-${t}-M`, 65_000],
    ]),
  );
});

test("keeps a column mapping for the next import until it is deleted", async ({ page, business }) => {
  void business;
  const t = tag();
  const csv = [
    "Judul;Nomor SKU;Harga Jual;Harga Modal;Berat (gram);Stok",
    `Kemeja Batik ${t};MAP-${t}-S;Rp 65.000;35.000;300;5`,
  ].join("\r\n");
  await page.goto("/migrasi");
  await page.getByText("BigSeller", { exact: true }).click();
  await page
    .getByLabel("Berkas ekspor")
    .setInputFiles({ name: "ekspor.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Unggah dan petakan kolom" }).click();
  await page.waitForURL(/job=01/);
  await page.getByLabel("Simpan pemetaan ini (opsional)").fill(`BigSeller ${t}`);
  await page.getByRole("button", { name: "Periksa berkas" }).click();
  await expect(page.getByText("Berkas siap diimpor")).toBeVisible({ timeout: 30_000 });

  await page.goto("/migrasi");
  await page.getByText("BigSeller", { exact: true }).click();
  await page.getByRole("combobox", { name: "Pemetaan tersimpan" }).click();
  await page.getByRole("option", { name: `BigSeller ${t}` }).click();
  await page.getByRole("button", { name: `Hapus pemetaan BigSeller ${t}` }).click();
  await page.getByRole("button", { name: "Hapus pemetaan", exact: true }).click();
  await expect(page.getByText(`Pemetaan BigSeller ${t} dihapus.`)).toBeVisible();
  // it was the only one: nothing saved to choose from
  await expect(page.getByRole("combobox", { name: "Pemetaan tersimpan" })).toHaveCount(0);
});
