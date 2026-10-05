import { call, expect, seedShop, tag, test } from "./fixtures";

test("an order goes from new to shipped: accept, pack by scan, label, courier handover", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);

  await page.goto("/pesanan?status=new");
  await page
    .getByRole("checkbox", { name: `Pilih pesanan ${shop.order.number}` })
    .first()
    .click();
  await page.getByRole("button", { name: "Terima" }).click();
  await expect(page.getByText("1 pesanan diterima.")).toBeVisible();

  await page.goto("/pengiriman");
  const order = page.getByLabel("Pindai nomor pesanan atau resi");
  await order.fill(shop.order.number);
  await order.press("Enter");
  const item = page.getByLabel("Pindai barang (barcode atau SKU)");
  await item.fill(`KAOS-${t}-PTH`);
  await item.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "tidak ada di pesanan ini" })).toBeVisible();
  for (const code of [`KAOS-${t}-HTM`, `KAOS-${t}-HTM`, `TMB-${t}-500`]) {
    await item.fill(code);
    await item.press("Enter");
  }
  await page.getByRole("button", { name: "Tandai dikemas" }).click();
  await expect(page.getByText(`Pesanan ${shop.order.number} dikemas.`)).toBeVisible();

  await page.getByRole("tab", { name: "Cetak label" }).click();
  await page.getByRole("checkbox", { name: `Pilih pesanan ${shop.order.number}` }).click();
  await page.getByRole("button", { name: "Buat label (1)" }).click();
  const link = page.getByRole("link", { name: "Unduh PDF" });
  await expect(link).toBeVisible({ timeout: 60_000 });
  const pdf = await page.request.get((await link.getAttribute("href")) ?? "");
  expect(pdf.headers()["content-type"]).toContain("pdf");

  await page.getByRole("tab", { name: "Serah terima" }).click();
  await page.getByRole("button", { name: "Buka manifest" }).click();
  const parcel = page.getByLabel("Pindai resi atau nomor pesanan");
  await parcel.fill(shop.order.number);
  await parcel.press("Enter");
  await expect(page.getByText(/masuk manifest/)).toBeVisible();
  await page.getByRole("button", { name: "Selesaikan serah terima J&T Express (1 paket)" }).click();
  await page.getByRole("dialog").getByLabel("Nama kurir yang menerima (opsional)").fill("Andi");
  await page.getByRole("dialog").getByRole("button", { name: "Selesaikan serah terima" }).click();
  await expect(page.getByText("1 paket diserahkan ke J&T Express.")).toBeVisible();

  const shipped = await call<{ status: string }>(page, "GET", `/v1/orders/${shop.order.id}`);
  expect(shipped.status).toBe("shipped");
});
