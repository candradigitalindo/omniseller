import { expect, test } from "@playwright/test";

for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`AMS search and commission periods at ${size.width}px`, async ({ page, context, baseURL }, info) => {
    await page.setViewportSize(size);
    await context.addCookies([{ name: "os_session", value: "ams-ui-fixture", url: baseURL! }]);
    const storeId = "01JSTORE000000000000000001";
    const product = {
      externalItemId: "9223372036854775806",
      externalCampaignId: "123",
      title: "Kaos Merah Premium Indonesia",
      status: "ongoing",
      externalStatus: "Ongoing",
      commissionBasisPoints: 125,
      startsAt: "2026-10-01T00:00:00.000Z",
      endsAt: null,
      pendingTerminationAt: null,
      protections: [{ commissionBasisPoints: 200, endsAt: "2026-10-31T00:00:00.000Z" }],
      maxCommissionBasisPointsToday: 200,
    };
    let result: object | null = null;
    await page.route("**/v1/**", async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      let data: unknown = { items: [] };
      if (path === "/v1/me")
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
          permissions: ["affiliate:read"],
          storeScope: null,
          warehouseScope: null,
        };
      if (path === "/v1/stores")
        data = {
          items: [
            {
              id: storeId,
              name: "Toko Utama",
              channel: "shopee",
              region: "ID",
              status: "active",
              syncMode: "read_only",
            },
          ],
        };
      if (path === `/v1/stores/${storeId}/affiliate/products`) {
        if (req.method() === "POST") {
          expect(req.headers()["idempotency-key"]).toBeTruthy();
          expect(req.postDataJSON()).toMatchObject({
            search: { by: "name", value: "Kaos" },
            sortBy: "-commission_rate",
            pageSize: size.width < 768 ? 3 : 8,
          });
          result = {
            id: "01JQUERY00000000000000001",
            storeId,
            query: req.postDataJSON(),
            status: "succeeded",
            items: [product],
            total: 1,
            nextCursor: null,
            errorCode: null,
            errorMessage: null,
            createdAt: "2026-10-17T00:00:00.000Z",
            finishedAt: "2026-10-17T00:00:01.000Z",
            expiresAt: "2026-10-18T00:00:00.000Z",
          };
          data = { ...result, status: "queued", items: [], total: null };
        } else data = { request: result };
      }
      await route.fulfill({
        status: req.method() === "POST" ? 202 : 200,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    });
    await page.goto("/affiliate");
    await page.getByRole("button", { name: "Cari produk", exact: true }).click();
    const search = page.getByRole("dialog", { name: "Pencarian produk AMS" });
    await search.getByLabel("Kata kunci").fill("Kaos");
    await search.getByRole("combobox", { name: "Urutan komisi" }).click();
    await expect(page.getByRole("searchbox", { name: "Cari pilihan…" })).toBeVisible();
    await page.getByRole("option", { name: "Komisi tertinggi" }).click();
    await search.getByRole("button", { name: "Tampilkan produk" }).click();
    await page.getByRole("button", { name: `Detail ${product.title}` }).click();
    const detail = page.getByRole("dialog", { name: "Detail produk AMS" });
    await expect(detail.getByText("9223372036854775806")).toBeVisible();
    await expect(detail.getByText("1,25%", { exact: true })).toBeVisible();
    await detail.getByRole("tab", { name: "Periode" }).click();
    await expect(detail.getByText("Tanpa batas waktu")).toBeVisible();
    await expect(detail.getByRole("button", { name: "Tutup", exact: true }).first()).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await detail.boundingBox())!.height).toBeLessThanOrEqual(size.height);
    await detail.screenshot({ path: info.outputPath("ams-periods.png") });
    await page.keyboard.press("Escape");
    await expect(detail).not.toBeVisible();
  });
}
