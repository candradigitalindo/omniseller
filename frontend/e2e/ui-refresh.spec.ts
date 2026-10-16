import AxeBuilder from "@axe-core/playwright";
import { call, expect, seedShop, tag, test } from "./fixtures";

test("keeps authentication usable on small phones, tablets, desktops, and a short landscape screen", async ({
  page,
}) => {
  await page.goto("/masuk");
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
    { width: 844, height: 390 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("heading", { name: "Masuk ke OmniSeller" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByLabel("Email", { exact: true }).fill("uji@example.test");
    await page.getByLabel("Kata sandi", { exact: true }).fill("kata-sandi-uji");
    await page.getByRole("button", { name: "Tampilkan sandi" }).click();
    await expect(page.getByLabel("Kata sandi", { exact: true })).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Sembunyikan sandi" }).click();
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("searches a select and applies an Indonesian date from a calendar modal", async ({ page, business }) => {
  void business;
  await seedShop(page, tag());
  await page.goto("/pesanan");
  await page.getByRole("combobox", { name: "Kanal", exact: true }).click();
  await page.getByRole("searchbox", { name: "Cari pilihan…" }).fill("langsung");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option", { name: "Penjualan langsung" }).click();
  await page.getByLabel("Dari tanggal", { exact: true }).fill("05/10/2026");
  await page.getByLabel("Dari tanggal", { exact: true }).press("Tab");
  await expect(page).toHaveURL(/from=2026-10-05/);
  await page.getByRole("button", { name: "Pilih tanggal", exact: true }).first().click();
  const calendar = page.getByRole("dialog", { name: "Pilih tanggal", exact: true });
  await calendar.getByRole("combobox", { name: "Bulan" }).click();
  await page.getByRole("searchbox").fill("Oktober");
  await page.getByRole("option", { name: "Oktober" }).click();
  await calendar.getByRole("button", { name: "6 Oktober 2026", exact: true }).click();
  await calendar.getByRole("button", { name: "Gunakan pilihan" }).click();
  await expect(page.getByLabel("Dari tanggal", { exact: true })).toHaveValue("06/10/2026");
  await expect(page).toHaveURL(/from=2026-10-06/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("keeps a dirty manual order in its modal until the seller confirms leaving", async ({ page, business }) => {
  void business;
  await seedShop(page, tag());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/pesanan/baru");
  await page.getByRole("button", { name: "Lanjutkan" }).click();
  await page.getByLabel("Nama pembeli").fill("Pembeli uji");
  await page.getByRole("button", { name: "Tutup", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Tutup pesanan ini?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Kembali" }).click();
  await expect(page.getByLabel("Nama pembeli")).toHaveValue("Pembeli uji");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Tutup", exact: true }).click();
  await page.getByRole("button", { name: "Keluar tanpa menyimpan" }).click();
  await expect(page).toHaveURL(/\/pesanan$/);
  expect((await call<{ items: unknown[] }>(page, "GET", "/v1/orders")).items).toHaveLength(1);
});
