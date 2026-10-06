import { call, expect, seedShop, tag, test } from "./fixtures";

test("scans an order to print its label on the station's print agent", async ({
  page,
  business,
  playwright,
  baseURL,
}) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  const paired = await call<{ agent: { id: string }; token: string }>(page, "POST", "/v1/print-agents", {
    name: `PC Kemas ${t}`,
    warehouseId: null,
  });
  // the agent reports in with its own token, as the desktop app does
  const agent = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { authorization: `Bearer ${paired.token}` },
  });
  const status = await agent.put("/v1/agent/status", {
    data: { appVersion: "1.4.0", printers: [{ name: "Zebra GK420d", isDefault: true }] },
  });
  expect(status.ok(), await status.text()).toBe(true);

  await page.goto("/pengiriman");
  await page.getByRole("tab", { name: "Cetak label" }).click();
  const box = page.getByLabel("Pindai nomor pesanan atau resi untuk dicetak");
  await expect(box).toBeDisabled();
  await page.getByRole("combobox", { name: "Cetak ke" }).click();
  await page.getByRole("option", { name: `PC Kemas ${t} · terhubung` }).click();
  await box.fill(shop.order.number);
  await box.press("Enter");
  await expect(page.getByText(`Label ${shop.order.number} dikirim ke printer`)).toBeVisible();
  await box.fill("RESI-TIDAK-ADA");
  await box.press("Enter");
  await expect(page.getByText("Nomor pesanan atau resi tidak ditemukan.")).toBeVisible();

  // the agent sees the job once the worker has drawn the label
  await expect
    .poll(
      async () => {
        const jobs: { items: { title: string }[] } = await (await agent.get("/v1/agent/print-jobs")).json();
        return jobs.items.map((j) => j.title);
      },
      { timeout: 60_000 },
    )
    .toContain(`Label ${shop.order.number}`);
  await agent.dispose();
});

test("cancels an open manifest, and its parcel goes into another", async ({ page, business }) => {
  void business;
  const shop = await seedShop(page, tag());
  await call(page, "POST", "/v1/orders/accept", { orderIds: [shop.order.id] });
  await call(page, "POST", "/v1/orders/pack", { orderIds: [shop.order.id] });

  await page.goto("/pengiriman");
  await page.getByRole("tab", { name: "Serah terima" }).click();
  await page.getByRole("button", { name: "Buka manifest" }).click();
  const parcel = page.getByLabel("Pindai resi atau nomor pesanan");
  await parcel.fill(shop.order.number);
  await parcel.press("Enter");
  await expect(page.getByText(/masuk manifest/)).toBeVisible();

  await page.getByRole("button", { name: "Batalkan manifest" }).click();
  const ask = page.getByRole("dialog");
  await expect(ask).toContainText("1 paket yang sudah dipindai bisa dipindai lagi ke manifest lain.");
  await ask.getByRole("button", { name: "Batalkan manifest" }).click();
  await expect(page.getByText(/Manifest MNF-\S+ dibatalkan\./)).toBeVisible();

  await page.getByRole("button", { name: "Buka manifest" }).click();
  await parcel.fill(shop.order.number);
  await parcel.press("Enter");
  await expect(page.getByText(/masuk manifest/)).toBeVisible();
});

test("makes barcode labels of a product's variants as a PDF", async ({ page, business }) => {
  void business;
  const t = tag();
  await seedShop(page, t);
  const found = await call<{ items: { id: string }[] }>(page, "GET", `/v1/products?q=KAOS-${t}`);

  await page.goto(`/produk/${found.items[0]!.id}`);
  await page.getByRole("tab", { name: "Varian" }).click();
  await page.getByRole("button", { name: "Cetak label barcode" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(`Jumlah label KAOS-${t}-HTM`).fill("3");
  await dialog.getByLabel(`Jumlah label KAOS-${t}-PTH`).fill("0");
  await dialog.getByRole("group", { name: "Ukuran label" }).getByText("A4, 30 label").click();
  await dialog.getByRole("button", { name: "Buat PDF 3 label" }).click();

  const link = dialog.getByRole("link", { name: "Unduh PDF" });
  await expect(link).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText("Dokumen siap (1 halaman).")).toBeVisible();
  const pdf = await page.request.get((await link.getAttribute("href")) ?? "");
  expect(pdf.headers()["content-type"]).toContain("pdf");
});
