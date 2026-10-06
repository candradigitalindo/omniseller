import { expect, seedShop, tag, test } from "./fixtures";

test("opens a sales channel's page from its card and renames it", async ({ page, business }) => {
  void business;
  const t = tag();
  const shop = await seedShop(page, t);
  await page.goto("/integrasi");
  await page.getByRole("link", { name: "Kelola WhatsApp" }).click();
  await page.waitForURL(`**/integrasi/${shop.storeId}`);

  const name = page.getByLabel("Nama toko");
  await name.fill(`WhatsApp ${t}`);
  await page.getByRole("button", { name: "Simpan nama" }).click();
  await expect(page.getByText("Nama toko disimpan.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: `WhatsApp ${t}` })).toBeVisible();
  // a manual channel has no connection or sync to manage
  await expect(page.getByRole("tablist")).toHaveCount(0);
});
