import { zonedToIso } from "../src/features/orders/manual-order-meta";
import { addDays, todayIn } from "../src/features/reports/report-meta";
import { temporalText } from "../src/lib/localized-input";
import { call, expect, seedShop, tag, test } from "./fixtures";

test("filters the queue by courier, calendar dates, and channel, then restores the shared view", async ({
  page,
  business,
}) => {
  void business;
  const shop = await seedShop(page, tag());
  const today = todayIn("Asia/Jakarta");
  const yesterday = addDays(today, -1);
  const place = async (courier: string, day: string) =>
    call<{ externalOrderId: string }>(page, "POST", "/v1/orders/manual", {
      storeId: shop.storeId,
      warehouseId: shop.warehouseId,
      buyer: { name: "Pembeli uji" },
      items: [{ variantId: shop.variants.white.id, qty: 1 }],
      paymentMethod: "cash",
      shippingProvider: courier,
      orderedAt: zonedToIso(`${day}T00:00`, "Asia/Jakarta"),
    });
  const match = await place("JNE", yesterday);
  await place("J&T Express", yesterday);
  await place("JNE", today);
  await page.goto("/pesanan");
  await page.getByRole("combobox", { name: "Kanal" }).click();
  await page.getByRole("option", { name: "Penjualan langsung" }).click();
  await page.getByRole("combobox", { name: "Kurir" }).click();
  await page.getByRole("option", { name: "JNE", exact: true }).click();
  await page.getByLabel("Dari tanggal", { exact: true }).fill(yesterday);
  await page.getByLabel("Sampai tanggal", { exact: true }).fill(yesterday);
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByText(match.externalOrderId)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Dari tanggal", { exact: true })).toHaveValue(temporalText(yesterday, "date"));
  await expect(page.getByRole("combobox", { name: "Kurir" })).toHaveText("JNE");
  await expect(table.getByText(match.externalOrderId)).toBeVisible();
  await page.getByRole("combobox", { name: "Kanal" }).click();
  await page.getByRole("option", { name: "Shopee", exact: true }).click();
  await expect(page.getByText("Tidak ada pesanan yang cocok dengan filter ini.")).toBeVisible();
  await page.getByRole("button", { name: "Bersihkan", exact: true }).click();
  await expect(page).toHaveURL(/\/pesanan$/);
  await expect(table.getByRole("row")).toHaveCount(5);
  // The same controls remain usable on a phone without horizontal page scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("combobox", { name: "Kurir" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("shows outstanding COD on the dashboard and updates it after completion", async ({ page, business }) => {
  void business;
  const shop = await seedShop(page, tag());
  const sale = await call<{ id: string }>(page, "POST", "/v1/orders/manual", {
    storeId: shop.storeId,
    warehouseId: shop.warehouseId,
    buyer: { name: "Pembeli COD" },
    items: [{ variantId: shop.variants.white.id, qty: 1, unitPrice: 123_456_789 }],
    paymentMethod: "cod",
  });
  await page.goto("/");
  const kpis = page.getByRole("region", { name: "COD belum diterima" });
  await expect(kpis.getByText("COD belum diterima", { exact: true })).toBeVisible();
  await expect(kpis.getByText(/Rp\s*123\.456\.789/)).toBeVisible();
  await expect(kpis.getByText("1 pesanan · semua periode")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const amount = kpis.getByText(/Rp\s*123\.456\.789/);
  await expect(amount).toBeVisible();
  expect(await amount.evaluate((el) => el.getBoundingClientRect().width <= window.innerWidth - 32)).toBe(true);
  await call(page, "POST", `/v1/orders/${sale.id}/complete`);
  await page.reload();
  await expect(kpis.getByText("0 pesanan · semua periode")).toBeVisible();
});

test("tags an order from the queue, then lists the queue by that tag", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  await page.goto("/pesanan");
  const table = page.getByRole("table");
  await table.getByRole("checkbox", { name: `Pilih pesanan ${shop.order.number}` }).check();
  await page.getByRole("button", { name: "Beri tag" }).click();
  const search = page.getByRole("textbox", { name: "Cari atau buat tag" });
  await search.fill(`Prioritas ${t}`);
  await search.press("Enter");
  await expect(page.getByRole("checkbox", { name: `Prioritas ${t}` })).toBeChecked();
  await page.getByRole("button", { name: "Terapkan" }).click();
  await expect(page.getByText("Tag diperbarui pada 1 pesanan.")).toBeVisible();
  await expect(table.getByText(`Prioritas ${t}`)).toBeVisible();

  await page.getByRole("combobox", { name: "Tag" }).click();
  await page.getByRole("option", { name: `Prioritas ${t}` }).click();
  await page.waitForURL(/tag=01/);
  await expect(table.getByText(shop.order.number)).toBeVisible();
});

test("moves an order nobody packed to another warehouse", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  const sby = await call<{ id: string }>(page, "POST", "/v1/warehouses", {
    code: `SBY${t.slice(0, 3)}`,
    name: `Gudang Surabaya ${t}`,
    address: { city: "Surabaya", province: "Jawa Timur" },
  });
  // one black shirt there, the order needs two (stock never set would say nothing, ADR-036)
  await call(page, "POST", "/v1/inventory/adjustments", {
    reason: "correction",
    lines: [
      { variantId: shop.variants.black.id, warehouseId: sby.id, mode: "set", quantity: 1 },
      { variantId: shop.variants.tumbler.id, warehouseId: sby.id, mode: "set", quantity: 5 },
    ],
  });
  await page.goto(`/pesanan?id=${shop.order.id}`);
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Aksi lain" }).click();
  await page.getByRole("menuitem", { name: "Pindah gudang" }).click();
  const move = page.getByRole("dialog", { name: "Pindah gudang" });
  await move.getByRole("radio", { name: `Gudang Surabaya ${t}` }).click();
  await move.getByRole("button", { name: "Pindahkan" }).click();
  await expect(page.getByText(`Pesanan dipindah ke Gudang Surabaya ${t}.`)).toBeVisible();

  // one shirt short there, so the order now waits on its stock
  const order = await call<{ warehouseId: string; problems: { code: string }[] }>(
    page,
    "GET",
    `/v1/orders/${shop.order.id}`,
  );
  expect(order.warehouseId).not.toBe(shop.warehouseId);
  expect(order.problems.map((p) => p.code)).toContain("insufficient_stock");
});
