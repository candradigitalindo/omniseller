import { expect, test } from "./fixtures";

test("signs up, signs out, and signs back in to where the user was going", async ({ page }) => {
  const stamp = Date.now().toString(36);
  const email = `e2e-daftar-${stamp}@example.test`;
  await page.goto("/daftar");
  await page.getByLabel("Nama bisnis").fill(`Toko Daftar ${stamp}`);
  await page.getByLabel("Nama Anda").fill("Rina Wulandari");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill("E2e-kata-sandi-2026");
  await page.getByRole("checkbox", { name: /Saya menyetujui/ }).click();
  await page.getByRole("button", { name: "Daftar" }).click();
  await expect(page.getByText("Hubungkan toko pertama Anda")).toBeVisible();

  await page.getByRole("button", { name: "Rina Wulandari" }).first().click();
  await page.getByRole("menuitem", { name: "Keluar" }).click();
  await page.waitForURL(/\/masuk/);

  await page.goto("/stok");
  await page.waitForURL(/\/masuk\?next=%2Fstok/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill("E2e-kata-sandi-2026");
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/stok$/);
  await expect(page.getByRole("heading", { name: "Stok" })).toBeVisible();
});

test("refuses a wrong password in words", async ({ page, business }) => {
  await page.context().clearCookies();
  await page.goto("/masuk");
  await page.getByLabel("Email").fill(business.email);
  await page.getByLabel("Kata sandi").fill("salah-sekali-123");
  await page.getByRole("button", { name: "Masuk" }).click();
  // Next's route announcer is an alert too: look for the message itself
  await expect(page.getByRole("alert").filter({ hasText: /salah/i })).toBeVisible();
});
