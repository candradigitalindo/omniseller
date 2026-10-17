import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`marketplace inbox and confirmed reply at ${size.width}px`, async ({ page, context, baseURL }, info) => {
    await page.setViewportSize(size);
    await context.addCookies([{ name: "os_session", value: "inbox-ui-fixture", url: baseURL! }]);
    const principal = {
      id: "01JSTORE000000000000000001",
      kind: "seller",
      channel: "tiktokshop",
      name: "Toko Candra Indonesia",
      status: "active",
      region: "ID",
      scopes: ["seller.customer_service"],
      readOnly: false,
      sellerType: "local",
      categories: [],
    };
    const receipt = {
      id: "01JREQUEST0000000000000001",
      principalId: principal.id,
      kind: "conversations",
      status: "succeeded",
      conversations: [
        {
          id: "7494560109732334261",
          name: "Ayu",
          preview: "Apakah produk tersedia?",
          unread: 2,
          canReply: true,
          updatedAt: "2026-10-17T01:00:00Z",
        },
      ],
      messages: [],
      nextCursor: null,
      messageId: null,
      errorMessage: null,
    };
    let sends = 0;
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
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
            name: "Toko Candra",
            slug: "demo",
            timezone: "Asia/Jakarta",
            status: "active",
          },
          plan: { code: "growth", name: "Growth", features: [] },
          roles: [],
          permissions: ["commerce:read", "commerce:write", "chat:read", "chat:write"],
          storeScope: null,
          warehouseScope: null,
        };
      if (path === "/v1/commerce/principals") data = { items: [principal] };
      if (path === "/v1/commerce-inbox/conversations/search") data = { id: receipt.id };
      if (path === `/v1/commerce-inbox/requests/${receipt.id}`) data = receipt;
      if (path === "/v1/commerce-inbox/messages/search") data = { id: "messages" };
      if (path === "/v1/commerce-inbox/requests/messages")
        data = {
          ...receipt,
          kind: "messages",
          conversations: [],
          messages: [
            {
              id: "7494560109732334263",
              type: "TEXT",
              text: "Apakah produk tersedia?",
              sender: "Ayu",
              incoming: true,
              createdAt: "2026-10-17T01:00:00Z",
              mediaUrl: null,
            },
          ],
        };
      if (path === "/v1/commerce-inbox/messages/send") {
        sends++;
        expect(request.headers()["idempotency-key"]).toBeTruthy();
        expect(request.postDataJSON()).toEqual({
          principalId: principal.id,
          conversationId: "7494560109732334261",
          type: "TEXT",
          text: "Halo, produk tersedia.",
        });
        data = { id: "send" };
      }
      if (path === "/v1/commerce-inbox/requests/send")
        data = { ...receipt, kind: "send", conversations: [], messageId: "7494560109732334299" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("/commerce/pesan");
    await expect(page.getByRole("button", { name: "Buka percakapan Ayu" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("combobox", { name: "Pilih toko" }).click();
    await page.getByRole("searchbox", { name: "Cari pilihan…" }).fill("Candra");
    await page.getByRole("option", { name: "Toko Candra Indonesia · Tokopedia & Shop" }).click();
    await page.getByRole("button", { name: "Buka percakapan Ayu" }).click();
    const conversation = page.getByRole("dialog", { name: "Ayu", exact: true });
    await expect(conversation.getByText("Apakah produk tersedia?")).toBeVisible();
    await conversation.getByLabel("Tulis balasan").fill("Halo, produk tersedia.");
    await conversation.getByRole("button", { name: "Kirim balasan" }).click();
    const confirm = page.getByRole("dialog", { name: "Kirim balasan ke pelanggan?" });
    await expect(confirm.getByRole("button", { name: "Kirim balasan" })).toBeInViewport();
    expect((await confirm.boundingBox())!.height).toBeLessThanOrEqual(size.height);
    expect((await confirm.boundingBox())!.width).toBeLessThanOrEqual(size.width - 24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(sends).toBe(0);
    await page.waitForTimeout(150);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await confirm.screenshot({ path: info.outputPath("inbox-confirmation.png") });
    await confirm.getByRole("button", { name: "Kirim balasan" }).click();
    await expect(conversation.getByText(/Marketplace menerima permintaan/)).toBeVisible();
    expect(sends).toBe(1);
    expect(await conversation.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
