import { call, expect, seedShop, tag, test } from "./fixtures";

test("adjusts stock with a reason and shows the new number", async ({ page, business }) => {
  void business;
  const t = tag();
  await seedShop(page, t);
  await page.goto("/stok");
  await page.getByRole("button", { name: "Sesuaikan stok" }).click();
  await page.getByPlaceholder("Cari SKU atau nama produk").fill(`TMB-${t}`);
  await page.getByRole("button", { name: new RegExp(`TMB-${t}-500`) }).click();
  await page.getByRole("radio", { name: /Tambah atau kurangi/ }).click();
  await page.getByRole("spinbutton", { name: "Selisih" }).fill("-2");
  await page.getByRole("button", { name: "Simpan penyesuaian" }).click();
  await expect(page.getByText(`Stok TMB-${t}-500 disesuaikan: 10 → 8.`)).toBeVisible();
});

test("counts a warehouse blind, reviews the difference, and applies it", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  await page.goto("/stok/opname");
  await page.getByRole("button", { name: "Mulai opname" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mulai menghitung" }).click();
  await page.waitForURL(/\/stok\/opname\/01/);

  const box = page.getByLabel("Pindai barcode atau ketik SKU, lalu Enter");
  for (let i = 0; i < 3; i++) {
    await box.fill(`TMB-${t}-500`);
    await box.press("Enter");
  }
  await expect(page.getByText(new RegExp(`\\+3 TMB-${t}-500`))).toBeVisible();
  await page.getByRole("button", { name: "Kirim untuk ditinjau" }).click();
  await expect(page.getByRole("columnheader", { name: "Selisih" })).toBeVisible();
  await page.getByRole("button", { name: "Terapkan selisih" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Terapkan" }).click();
  await expect(page.getByText("Diterapkan", { exact: true }).first()).toBeVisible({ timeout: 60_000 });

  // ten on record, three counted: seven fewer, and nothing else touched
  const stock = await call<{ items: { sku: string; warehouses: { warehouseId: string; onHand: number }[] }[] }>(
    page,
    "GET",
    `/v1/inventory?q=${t}`,
  );
  const onHand = (sku: string) =>
    stock.items.find((i) => i.sku === sku)?.warehouses.find((w) => w.warehouseId === shop.warehouseId)?.onHand;
  expect(onHand(`TMB-${t}-500`)).toBe(3);
  expect(onHand(`KAOS-${t}-HTM`)).toBe(50);
});

test("moves stock to another warehouse and receives it short", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  await call(page, "POST", "/v1/warehouses", {
    code: `SBY${t.slice(0, 3)}`,
    name: `Gudang Surabaya ${t}`,
    address: { city: "Surabaya", province: "Jawa Timur" },
  });

  await page.goto("/stok/transfer");
  await page.getByRole("button", { name: "Buat transfer" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Dari gudang" }).click();
  await page.getByRole("option").first().click();
  await dialog.getByRole("combobox", { name: "Ke gudang" }).click();
  await page.getByRole("option", { name: `Gudang Surabaya ${t}` }).click();
  await dialog.getByLabel("Tambah SKU").fill(`KAOS-${t}-PTH`);
  await dialog.getByRole("button", { name: new RegExp(`KAOS-${t}-PTH`) }).click();
  await dialog.getByLabel(`Jumlah KAOS-${t}-PTH`).fill("4");
  await dialog.getByRole("button", { name: "Simpan draf" }).click();

  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Kirim barang" }).click();
  await expect(page.getByText(/Transfer dikirim/)).toBeVisible();
  await sheet.getByLabel(`Jumlah diterima KAOS-${t}-PTH`).fill("3");
  await sheet.getByRole("button", { name: "Terima barang" }).click();
  await expect(sheet.getByText("1 tidak tiba")).toBeVisible();

  const stock = await call<{ items: { sku: string; warehouses: { warehouseId: string; onHand: number }[] }[] }>(
    page,
    "GET",
    `/v1/inventory?q=KAOS-${t}-PTH`,
  );
  const cells = stock.items[0]!.warehouses;
  expect(cells.find((w) => w.warehouseId === shop.warehouseId)?.onHand).toBe(16);
  expect(cells.find((w) => w.warehouseId !== shop.warehouseId)?.onHand).toBe(3);
});

test("follows a SKU's stock card from the stock list to the order that reserved it", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  await page.goto(`/stok?q=KAOS-${t}-HTM`);
  await page.getByRole("button", { name: `Aksi lain untuk KAOS-${t}-HTM` }).click();
  await page.getByRole("menuitem", { name: "Lihat riwayat stok" }).click();
  await page.waitForURL(/\/stok\/riwayat\?variant=/);

  const table = page.getByRole("table");
  await expect(table.getByText("Pesanan masuk")).toBeVisible();
  await expect(table.getByText("Penyesuaian")).toBeVisible();
  await expect(table.getByText("Koreksi · stok awal e2e")).toBeVisible();
  await table.getByRole("link", { name: `Buka pesanan ${shop.order.number}` }).click();
  await page.waitForURL(`**/pesanan?id=${shop.order.id}`);
  await expect(page.getByRole("dialog").getByText(shop.order.number).first()).toBeVisible();
});

test("sets a SKU's minimum and shelf, and the stock list calls it running low", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  await page.goto(`/stok?q=TMB-${t}-500`);
  await page.getByRole("button", { name: `Aksi lain untuk TMB-${t}-500` }).click();
  await page.getByRole("menuitem", { name: "Atur minimum & rak" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Stok minimum").fill("12");
  await dialog.getByLabel("Lokasi rak").fill("A-01-03");
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText(`Pengaturan TMB-${t}-500 disimpan.`)).toBeVisible();

  const stock = await call<{
    items: { warehouses: { warehouseId: string; minStock: number | null; binLocation: string | null }[] }[];
  }>(page, "GET", `/v1/inventory?q=TMB-${t}-500&stock=low`);
  expect(stock.items[0]?.warehouses.find((w) => w.warehouseId === shop.warehouseId)).toMatchObject({
    minStock: 12,
    binLocation: "A-01-03",
  });
});
