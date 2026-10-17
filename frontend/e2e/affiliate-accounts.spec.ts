import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`creator account management at ${size.width}px`, async ({ page, context, baseURL }, info) => {
    await page.setViewportSize(size);
    await context.addCookies([{ name: "os_session", value: "accounts-ui-fixture", url: baseURL! }]);
    const account = {
      id: "01JACCOUNT00000000000000001",
      kind: "affiliate_partner",
      name: "Mitra Candra Indonesia",
      externalPrincipalId: "partner-id-long-fixture-123456789",
      region: "ID",
      status: "active",
      scopes: ["partner.authorization.info", "partner.affiliate.collaboration.read"],
      profile: { categories: [{ id: "123", name: "Kategori fixture pengujian", market: "ID" }] },
      connectedAt: "2026-10-17T00:00:00Z",
      disconnectedAt: null,
      accessExpiresAt: "2026-10-24T00:00:00Z",
      authorizationExpiresAt: "2027-10-17T00:00:00Z",
      errorCode: null,
      errorMessage: null,
      rowVersion: 1,
    };
    await page.route("**/v1/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      let data: unknown = { items: [] };
      if (url.pathname === "/v1/me")
        data = {
          user: {
            id: "01JUSER0000000000000000000",
            name: "Demo",
            email: "demo@example.test",
            locale: "id",
            twoFactorEnabled: false,
          },
          tenant: {
            id: "01JTENANT00000000000000000",
            name: "Demo",
            slug: "demo",
            timezone: "Asia/Jakarta",
            status: "active",
          },
          plan: { code: "growth", name: "Growth", features: [] },
          roles: [],
          permissions: ["affiliate:account_read", "affiliate:account_write"],
          storeScope: null,
          warehouseScope: null,
        };
      if (url.pathname === "/v1/affiliate/accounts") {
        expect(url.searchParams.get("limit")).toBe(size.width < 768 ? "1" : "6");
        data = { items: [account], next_cursor: null };
      }
      if (url.pathname === `/v1/affiliate/accounts/${account.id}`) data = account;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("/affiliate/akun");
    await expect(page.getByRole("button", { name: `Detail ${account.name}` })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height);
    await page.getByRole("button", { name: "Hubungkan akun", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Hubungkan akun Indonesia" });
    await dialog.getByRole("combobox", { name: "Jenis akun" }).click();
    await page.getByRole("searchbox", { name: "Cari pilihan…" }).fill("partner");
    await page.getByRole("option", { name: "Affiliate Partner Indonesia" }).click();
    await expect(dialog.getByRole("button", { name: "Lanjutkan otorisasi" })).toBeInViewport();
    expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(size.height);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: `Detail ${account.name}` }).click();
    dialog = page.getByRole("dialog", { name: "Detail akun" });
    await expect(dialog.getByText(account.externalPrincipalId)).toBeVisible();
    await dialog.getByRole("tab", { name: "Kategori", exact: true }).click();
    await expect(dialog.getByText("Kategori fixture pengujian")).toBeVisible();
    await dialog.getByRole("tab", { name: "Izin", exact: true }).click();
    await dialog.getByLabel("Cari izin").fill("authorization");
    await expect(dialog.getByText("partner.authorization.info", { exact: true })).toBeVisible();
    await expect(dialog.getByText("partner.affiliate.collaboration.read", { exact: true })).not.toBeVisible();
    await dialog.getByRole("tab", { name: "Kelola" }).click();
    await expect(dialog.getByRole("button", { name: "Putuskan koneksi", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(size.height);
    await dialog.screenshot({ path: info.outputPath("account-management.png") });
    await page.waitForTimeout(200);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
  });
}
