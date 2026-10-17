import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`App Store explicit installation consent at ${size.width}px`, async ({ page, context, baseURL }) => {
    await page.setViewportSize(size);
    await context.addCookies([{ name: "os_session", value: "app-store-fixture", url: baseURL! }]);
    let confirmations = 0;
    let selected = false;
    const receipt = {
      id: "01JAUTH0000000000000000001",
      channel: "tiktokshop",
      storeId: null,
      status: "exchanging",
      expiresAt: "2026-10-18T00:10:00Z",
      callbackAt: "2026-10-18T00:00:00Z",
      completedAt: null,
      result: { stores: [], skipped: [], failed: [] },
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-10-18T00:00:00Z",
    };
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let data: unknown = { items: [] };
      if (path === "/v1/me")
        data = {
          user: {
            id: "01JUSER0000000000000000000",
            name: "Candra",
            email: "demo@example.test",
            locale: "id",
            twoFactorEnabled: false,
          },
          tenant: {
            id: "01JTENANT00000000000000000",
            name: "Toko Candra",
            slug: "candra",
            timezone: "Asia/Jakarta",
            status: "active",
          },
          plan: { code: "growth", name: "Growth", features: [] },
          roles: [],
          permissions: ["settings:store"],
          storeScope: null,
          warehouseScope: null,
        };
      if (path === "/v1/store-installations/tiktokshop")
        data = { confirmationToken: "x".repeat(43), expiresAt: receipt.expiresAt };
      if (path === "/v1/store-installations/tiktokshop/confirm") {
        confirmations++;
        expect(request.postDataJSON()).toEqual({ confirmationToken: "x".repeat(43), confirmed: true });
        data = receipt;
      }
      if (path === "/v1/store-installations/tiktokshop/select-shops") {
        expect(request.postDataJSON()).toEqual({
          authorizationId: receipt.id,
          confirmationToken: "x".repeat(43),
          confirmed: true,
          shopIds: ["12345"],
        });
        selected = true;
        data = { ...receipt, installation: { awaitingShopSelection: false, shops: [], selectedShopIds: ["12345"] } };
      }
      if (path === `/v1/store-authorizations/${receipt.id}`)
        data = selected
          ? {
              ...receipt,
              status: "succeeded",
              result: {
                stores: [
                  {
                    storeId: "01JSTORE000000000000000001",
                    name: "Toko Terverifikasi",
                    externalShopId: "12345",
                    reconnected: false,
                  },
                ],
                skipped: [],
                failed: [],
              },
            }
          : {
              ...receipt,
              installation: {
                awaitingShopSelection: true,
                shops: [{ externalShopId: "12345", name: "Toko Terverifikasi", region: "ID" }],
                selectedShopIds: [],
              },
            };
      await route.fulfill({ status: path.endsWith("/confirm") ? 202 : 200, json: data });
    });
    await page.goto("/integrasi/instalasi/tiktokshop");
    const review = page.getByRole("button", { name: "Tinjau pemasangan" });
    await expect(review).toBeVisible();
    expect(confirmations).toBe(0);
    const initial = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      screenWidth: innerWidth,
      screenHeight: innerHeight,
    }));
    expect(initial.width).toBeLessThanOrEqual(initial.screenWidth);
    expect(initial.height).toBeLessThanOrEqual(initial.screenHeight + 2);
    await review.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Identitas toko belum diverifikasi/)).toBeVisible();
    const connect = dialog.getByRole("button", { name: "Verifikasi toko terlebih dahulu" });
    await expect(connect).toBeDisabled();
    expect(confirmations).toBe(0);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.width).toBeLessThanOrEqual(size.width);
    expect(bounds!.height).toBeLessThanOrEqual(size.height);
    const accessibility = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await dialog.getByRole("checkbox").check();
    await connect.click();
    await expect(page.getByRole("heading", { name: "Identitas toko siap ditinjau" })).toBeVisible();
    expect(selected).toBe(false);
    await page.getByRole("button", { name: "Tinjau dan pilih toko" }).click();
    const verified = page.getByRole("dialog");
    await expect(verified.getByText("ID toko: 12345 · Indonesia")).toBeVisible();
    await expect(verified.getByRole("button", { name: "Hubungkan 0 toko pilihan" })).toBeDisabled();
    await verified.getByRole("checkbox").check();
    await verified.getByRole("button", { name: "Hubungkan 1 toko pilihan" }).click();
    await expect(page.getByRole("heading", { name: "Toko berhasil terhubung" })).toBeVisible();
    expect(confirmations).toBe(1);
    await expect(page.getByText("Toko Terverifikasi")).toBeVisible();
  });
}
