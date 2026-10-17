import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`tenant app credentials, callbacks and availability at ${size.width}px`, async ({ page, business }, info) => {
    void business;
    await page.setViewportSize(size);
    await page.goto("/integrasi");
    await page.getByRole("button", { name: "Pengaturan marketplace", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Atur kredensial Shopee" }).click();
    await dialog.getByLabel("Partner ID", { exact: true }).fill("1900001");
    await dialog.getByLabel("Partner Key", { exact: true }).fill("LOCAL_UI_TEST_SECRET_ONLY");
    await dialog.getByRole("combobox", { name: "Lingkungan aplikasi" }).click();
    await page.getByRole("searchbox", { name: "Cari pilihan…" }).fill("sandbox");
    await page.getByRole("option", { name: "Sandbox Shopee" }).click();
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/marketplace-applications/shopee") && response.request().method() === "PUT",
    );
    await dialog.getByRole("button", { name: "Simpan kredensial" }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    const application = await response.json();
    expect(application.source).toBe("tenant");
    expect(application.environment).toBe("sandbox");
    expect(JSON.stringify(application)).not.toContain("LOCAL_UI_TEST_SECRET_ONLY");
    await expect(dialog.getByText("Siap dihubungkan")).toBeVisible();
    await dialog.getByRole("button", { name: "Alamat callback", exact: true }).click();
    await expect(dialog.getByLabel("Redirect URL", { exact: true })).toHaveValue(/\/integrasi\/callback\/shopee$/);
    await expect(dialog.getByLabel("Webhook URL", { exact: true })).toHaveValue(
      new RegExp(`/webhooks/shopee/apps/${application.applicationId}$`),
    );
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(size.height);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await dialog.screenshot({ path: info.outputPath("tenant-marketplace-callbacks.png") });
    await dialog.getByRole("button", { name: "Kembali", exact: true }).click();
    await dialog.getByRole("button", { name: "Atur kredensial Shopee" }).click();
    await expect(dialog.getByLabel("Partner Key", { exact: true })).toHaveValue("");
    await expect(dialog.getByLabel("Partner ID", { exact: true })).toHaveValue("1900001");
    // Creating an authorization link performs no external request or token exchange.
    const start = await page.request.post("/v1/store-authorizations", { data: { channel: "shopee" } });
    expect(start.status()).toBe(201);
    const url = new URL((await start.json()).authorizeUrl);
    expect(url.origin).toBe("https://open.sandbox.test-stable.shopee.com");
    expect(url.searchParams.get("partner_id")).toBe("1900001");
  });
}
