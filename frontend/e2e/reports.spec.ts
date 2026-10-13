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

  // the whole report as one Excel workbook, from the "Unduh laporan" menu
  await page.getByRole("button", { name: "Unduh laporan" }).click();
  const xlsx = await page.request.get(
    (await page.getByRole("menuitem", { name: "Excel (semua bagian)" }).getAttribute("href")) ?? "",
  );
  expect(xlsx.headers()["content-type"]).toContain("spreadsheetml.sheet");
  expect(xlsx.headers()["content-disposition"]).toMatch(/penjualan-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.xlsx/);
  expect((await xlsx.body()).subarray(0, 2).toString()).toBe("PK");
  await page.keyboard.press("Escape");
  // the weekly and monthly emails are chosen on the notifications page
  await page.getByRole("link", { name: "Jadwalkan email" }).click();
  await expect(page).toHaveURL(/\/notifikasi$/);
  await expect(page.getByRole("switch", { name: /Email untuk Laporan penjualan mingguan/ })).toBeVisible();
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
  // every row as Excel or CSV
  await page.getByRole("button", { name: "Unduh" }).click();
  const xlsx = await page.request.get((await page.getByRole("menuitem", { name: "Excel" }).getAttribute("href")) ?? "");
  expect(xlsx.headers()["content-disposition"]).toBe('attachment; filename="perlu-restock.xlsx"');
  expect((await xlsx.body()).subarray(0, 2).toString()).toBe("PK");
});

test("the team report counts who accepted and packed by scan, with minutes per order", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  await call(page, "POST", "/v1/orders/accept", { orderIds: [shop.order.id] });

  // packed at the station: it measures how long the order took
  await page.goto("/pengiriman");
  const order = page.getByLabel("Pindai nomor pesanan atau resi");
  await order.fill(shop.order.number);
  await order.press("Enter");
  const item = page.getByLabel("Pindai barang (barcode atau SKU)");
  for (const code of [`KAOS-${t}-HTM`, `KAOS-${t}-HTM`, `TMB-${t}-500`]) {
    await item.fill(code);
    await item.press("Enter");
  }
  await page.getByRole("button", { name: "Tandai dikemas" }).click();
  await expect(page.getByText(`Pesanan ${shop.order.number} dikemas.`)).toBeVisible();

  await page.goto("/laporan/kinerja-tim");
  const kpis = page.getByRole("region", { name: "Angka tim" });
  const tile = (label: string) => kpis.getByText(label, { exact: true }).locator("..");
  await expect(tile("Pesanan diproses").getByText("1", { exact: true })).toBeVisible();
  await expect(tile("Dikemas").getByText("1 dengan scan")).toBeVisible();
  await expect(tile("Menit kemas per pesanan").getByText(/^\d+,\d menit$/)).toBeVisible();
  const members = page.getByRole("region", { name: "Per anggota tim" });
  await expect(members.getByRole("row", { name: /Rina Wulandari/ })).toContainText("1 (1 scan)");

  // the member's history names them
  const detail = await call<{ events: { type: string; toStatus: string | null; actorName: string | null }[] }>(
    page,
    "GET",
    `/v1/orders/${shop.order.id}`,
  );
  expect(detail.events.find((e) => e.toStatus === "packed")?.actorName).toBe("Rina Wulandari");

  await page.getByRole("button", { name: "Unduh" }).click();
  const csv = await page.request.get(
    (await page.getByRole("menuitem", { name: "Per anggota (CSV)" }).getAttribute("href")) ?? "",
  );
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toMatch(/\r\nRina Wulandari;1;1;1;0;0;0;0;1;\d+\r\n/);
  const xlsx = await page.request.get(
    (await page.getByRole("menuitem", { name: "Excel (per anggota dan per hari)" }).getAttribute("href")) ?? "",
  );
  expect(xlsx.headers()["content-type"]).toContain("spreadsheetml.sheet");
  expect(xlsx.headers()["content-disposition"]).toMatch(/kinerja-tim-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.xlsx/);
});
