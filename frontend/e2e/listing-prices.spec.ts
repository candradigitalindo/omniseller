import { expect, test } from "@playwright/test";

/** Real browser UI contract tests; marketplace behavior is covered by backend e2e separately. */
for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`marketplace price modal stays usable at ${size.width}px`, async ({ page, context, baseURL }, info) => {
    await page.setViewportSize(size);
    await context.addCookies([{ name: "os_session", value: "ui-contract-fixture", url: baseURL! }]);
    const storeId = "01JSTORE000000000000000001";
    const listing = {
      id: "01JLISTING0000000000000001",
      storeId,
      store: { name: "Toko Utama", channel: "shopee", channelName: "Shopee" },
      externalItemId: "123",
      externalVariantId: "456",
      sku: "KAOS-M",
      title: "Kaos Merah",
      variantName: "M",
      attributes: {},
      imageUrl: null,
      price: 45000,
      originalPrice: 50000,
      status: "active",
      statusDetail: {},
      stock: 10,
      stockByWarehouse: {},
      mapping: null,
      lastPulledAt: "2026-10-17T00:00:00.000Z",
    };
    let history: object[] = [];
    await page.route("**/v1/**", async (route) => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      let data: unknown = { items: [], next_cursor: null };
      if (pathname === "/v1/me")
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
          permissions: ["catalog:read", "price:write", "settings:store"],
          storeScope: null,
          warehouseScope: null,
        };
      if (pathname === "/v1/stores")
        data = { items: [{ id: storeId, name: "Toko Utama", channel: "shopee", status: "active", syncMode: "live" }] };
      if (pathname === "/v1/listings/summary") data = { total: 1, mapped: 0, unmapped: 1 };
      if (pathname === "/v1/listings") data = { items: [listing], next_cursor: null };
      if (pathname === `/v1/listings/${listing.id}`) data = listing;
      if (pathname === `/v1/listings/${listing.id}/price-changes`) {
        if (req.method() === "POST") {
          expect(req.postDataJSON()).toEqual({ price: 65000, expectedPrice: 50000 });
          expect(req.headers()["idempotency-key"]).toBeTruthy();
          history = [
            {
              id: "01JCHANGE00000000000000001",
              listingId: listing.id,
              expectedPrice: 50000,
              requestedPrice: 65000,
              observedPrice: null,
              status: "queued",
              canCancel: true,
              errorCode: null,
              errorMessage: null,
              createdAt: "2026-10-17T00:00:00.000Z",
              updatedAt: "2026-10-17T00:00:00.000Z",
            },
          ];
          data = history[0];
        } else data = { items: history };
      }
      await route.fulfill({
        status: req.method() === "POST" ? 202 : 200,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    });
    await page.goto("/listing?tab=all");
    await page.getByRole("button", { name: "Harga & riwayat Kaos Merah" }).click();
    const dialog = page.getByRole("dialog", { name: "Harga marketplace" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Harga reguler baru" }).fill("65000");
    await expect(dialog.getByRole("textbox", { name: "Harga reguler baru" })).toHaveValue("65.000");
    await dialog.getByRole("button", { name: "Kirim harga baru" }).click();
    await expect(dialog.getByText("Menunggu worker", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Batalkan antrean" })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Tutup", exact: true }).first()).toBeInViewport();
    expect(
      await dialog.locator('[data-slot="tabs"]').evaluate((body) => body.scrollHeight <= body.clientHeight + 1),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.screenshot({ path: info.outputPath("price-modal.png") });
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(size.width);
    expect(bounds!.height).toBeLessThanOrEqual(size.height);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });
}
