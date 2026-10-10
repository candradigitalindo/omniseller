import AxeBuilder from "@axe-core/playwright";
import { call, expect, test } from "./fixtures";

test("the owner closes the account, takes the data, and reopens it before it goes", async ({ page, business }) => {
  await page.goto("/profil-bisnis");
  await page.getByRole("button", { name: "Tutup akun bisnis" }).click();
  const dialog = page.getByRole("dialog", { name: `Tutup akun ${business.name}?` });
  await dialog.getByLabel(`Ketik nama bisnis: ${business.name}`).fill(business.name.toUpperCase());
  await dialog.getByLabel("Kata sandi Anda").fill(business.password);
  await dialog.getByRole("button", { name: "Tutup akun" }).click();

  // the app gives way to the closing page: when the data goes, and the export
  await expect(page.getByRole("heading", { level: 1, name: `Akun ${business.name} sedang ditutup` })).toBeVisible();
  await expect(page.getByText(/\(30 hari lagi\)/)).toBeVisible();
  const me = await call<{ tenant: { status: string } }>(page, "GET", "/v1/me");
  expect(me.tenant.status).toBe("closing");
  await page.getByRole("button", { name: "Buat ekspor" }).click();
  await expect(page.getByText("Ekspor sedang disiapkan.", { exact: false })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

  // writes elsewhere are refused while it closes
  const refused = await page.request.post("/v1/tags", { data: { name: "Baru" } });
  expect(refused.status()).toBe(403);

  await page.getByRole("button", { name: "Buka kembali akun" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Buka kembali" }).click();
  await expect(page.getByText("Akun dibuka kembali.")).toBeVisible();
  await page.goto("/profil-bisnis");
  await expect(page.getByRole("heading", { level: 1, name: "Profil Bisnis & Legalitas" })).toBeVisible();
  expect((await call<{ tenant: { status: string } }>(page, "GET", "/v1/me")).tenant.status).toBe("active");
});
