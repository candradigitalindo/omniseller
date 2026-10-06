import { call, expect, seedShop, tag, test } from "./fixtures";

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
