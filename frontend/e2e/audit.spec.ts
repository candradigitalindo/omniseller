import { call, expect, seedShop, tag, test } from "./fixtures";

test("shows who changed a price, by SKU, and narrows the log to stock", async ({ page, business }) => {
  void business;
  const t = tag();
  await seedShop(page, t);
  const found = await call<{ items: { id: string; variants: { id: string; sku: string }[] }[] }>(
    page,
    "GET",
    `/v1/products?q=KAOS-${t}`,
  );
  const shirt = found.items[0]!;
  const black = shirt.variants.find((v) => v.sku === `KAOS-${t}-HTM`)!;
  await call(page, "PATCH", `/v1/products/${shirt.id}/variants/${black.id}`, { basePrice: 69_000 });

  await page.goto("/log-audit");
  const log = page.getByRole("list", { name: "Log Audit" });
  const latest = log.locator(":scope > li").first();
  await expect(latest).toContainText(`Mengubah varian KAOS-${t}-HTM`);
  await expect(latest).toContainText("Rp 65.000 → Rp 69.000");
  await expect(latest).toContainText("Rina Wulandari");

  await page.getByRole("combobox", { name: "Jenis perubahan" }).click();
  await page.getByRole("option", { name: "Stok", exact: true }).click();
  await expect(page).toHaveURL(/kind=stock/);
  await expect(log).toContainText(`Menyesuaikan stok KAOS-${t}-HTM`);
  await expect(log).not.toContainText("Mengubah varian");
});

test("changes the password from the account page, then signs in with the new one", async ({ page, business }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Rina Wulandari" }).first().click();
  await page.getByRole("menuitem", { name: "Akun saya" }).click();
  await page.waitForURL("**/akun");

  const next = `${business.password}-baru`;
  await page.getByLabel("Kata sandi saat ini").fill(business.password);
  await page.getByLabel("Kata sandi baru", { exact: true }).fill(next);
  await page.getByLabel("Ulangi kata sandi baru").fill(next);
  await page.getByRole("button", { name: "Simpan kata sandi baru" }).click();
  await expect(page.getByText("Kata sandi diganti. Perangkat lain sudah dikeluarkan.")).toBeVisible();

  await page.request.post("/v1/auth/logout");
  await page.goto("/masuk");
  await page.getByLabel("Email").fill(business.email);
  await page.getByLabel("Kata sandi").fill(next);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL((url) => url.pathname === "/");
});
