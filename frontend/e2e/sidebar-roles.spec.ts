import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

test("groups desktop and mobile menus, opens the active category, and keeps navigation accessible", async ({
  page,
  business,
}) => {
  void business;
  await page.goto("/tim?tab=peran");
  await expect(page.getByRole("button", { name: "Tim & Akses" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Tim & Peran", exact: true })).toHaveAttribute("aria-current", "page");
  const stock = page.getByRole("button", { name: "Stok & Gudang" });
  await expect(stock).toHaveAttribute("aria-expanded", "false");
  await stock.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Stock Opname", exact: true }).click();
  await expect(page).toHaveURL(/\/stok\/opname$/);
  await expect(page.getByRole("link", { name: "Stock Opname", exact: true })).toHaveAttribute("aria-current", "page");
  const desktop = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(desktop.violations).toEqual([]);

  await page.getByRole("main").getByRole("button", { name: "Buka atau tutup menu" }).click();
  await expect(page.getByRole("link", { name: "Langganan & Tagihan", exact: true })).toBeAttached();
  await page.getByRole("link", { name: "Langganan & Tagihan", exact: true }).click();
  await expect(page).toHaveURL(/\/langganan$/);

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "Menu", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button", { name: "Bisnis & Integrasi" })).toHaveAttribute("aria-expanded", "true");
    await menu.getByRole("button", { name: "Tim & Akses" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await menu.getByRole("link", { name: "Tim & Peran", exact: true }).click();
    await expect(page).toHaveURL(/\/tim$/);
    await expect(menu).not.toBeVisible();
    await page.goto("/langganan");
  }
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const mobile = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(mobile.violations).toEqual([]);
});

test("creates a Starter role in a small-screen modal with searchable permissions", async ({ page, business }) => {
  void business;
  const down = await page.request.post("/v1/billing/subscription", { data: { planCode: "starter" } });
  expect(down.status()).toBe(200);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/tim?tab=peran");
  await page.getByRole("button", { name: "Buat peran", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Buat peran", exact: true });
  await dialog.getByLabel("Nama peran", { exact: true }).fill("Shift Mobile");
  await dialog.getByRole("searchbox", { name: "Cari izin", exact: true }).fill("Lihat pesanan");
  await dialog.getByRole("checkbox", { name: "Lihat pesanan", exact: true }).check();
  await dialog.getByRole("searchbox", { name: "Cari izin", exact: true }).fill("tidak-ada");
  await expect(dialog.getByText("Tidak ada izin yang cocok. Coba kata lain.")).toBeVisible();
  await expect(dialog.getByText("1 izin dipilih", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(result.violations).toEqual([]);
  await dialog.getByRole("button", { name: "Buat peran", exact: true }).click();
  await expect(page.getByRole("list", { name: "Peran kustom" }).getByText("Shift Mobile")).toBeVisible();
});
