import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`commerce forms and results at ${size.width}px`, async ({ page, context, baseURL }, info) => {
    await page.setViewportSize(size);
    await context.addCookies([{ name: "os_session", value: "commerce-ui-fixture", url: baseURL! }]);
    const principal = {
      id: "01JACCOUNT00000000000000001",
      kind: "creator",
      channel: "tiktokshop",
      name: "Candra Creator Indonesia",
      status: "active",
      scopes: ["creator.showcase.write"],
      region: "ID",
      readOnly: false,
      categories: [],
    };
    const operation = {
      id: "tiktokshop.creator.showcase.add",
      channel: "tiktokshop",
      principalKind: "creator",
      title: "Tambah produk etalase",
      group: "Showcase creator",
      method: "POST",
      path: "/affiliate_creator/202405/showcases/products",
      scopes: ["creator.showcase.write"],
      write: true,
      officialUrl: "https://partner.tiktokshop.com/docv2/page/add-showcase-products",
      available: true,
      unavailableReason: null,
      requiredPermissions: [],
      fields: [
        {
          name: "body.product_ids",
          label: "Produk etalase",
          type: "array",
          required: true,
          itemType: "string",
          minimum: 1,
          maximum: 20,
        },
      ],
    };
    const receipt = {
      id: "01JREQUEST0000000000000001",
      operationId: operation.id,
      principalId: principal.id,
      principalKind: principal.kind,
      status: "succeeded",
      result: {
        data: { products: [{ id: "9007199254740993", name: "Produk Candra", active: true }] },
        nextCursor: null,
        acknowledgement: "accepted",
      },
      nextCursor: null,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-10-17T01:00:00Z",
      finishedAt: "2026-10-17T01:00:01Z",
      expiresAt: "2026-10-18T01:00:00Z",
    };
    let writes = 0;
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
            name: "Demo",
            slug: "demo",
            timezone: "Asia/Jakarta",
            status: "active",
          },
          plan: { code: "growth", name: "Growth", features: [] },
          roles: [],
          permissions: ["commerce:read", "commerce:write"],
          storeScope: null,
          warehouseScope: null,
        };
      if (path === "/v1/commerce/operations") data = { items: [operation] };
      if (path === "/v1/commerce/principals") data = { items: [principal] };
      if (path === "/v1/commerce/requests" && request.method() === "POST") {
        writes++;
        expect(request.postDataJSON()).toEqual({
          operationId: operation.id,
          principalId: principal.id,
          input: { body: { product_ids: ["9007199254740993"] } },
          confirmed: true,
        });
        expect(request.headers()["idempotency-key"]).toBeTruthy();
        data = receipt;
      }
      if (path === `/v1/commerce/requests/${receipt.id}`) data = receipt;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("/commerce");
    await expect(page.getByRole("button", { name: "Buka: Tambah produk etalase" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height);
    await page.getByRole("combobox", { name: "Akun marketplace" }).click();
    await page.getByRole("searchbox", { name: "Cari pilihan…" }).fill("Candra");
    await page.getByRole("option", { name: "Candra Creator Indonesia · TikTok Shop · Creator" }).click();
    await page.getByRole("button", { name: "Buka: Tambah produk etalase" }).click();
    const dialog = page.getByRole("dialog", { name: "Tambah produk etalase" });
    await dialog.getByRole("button", { name: "Produk etalase" }).click();
    const items = page.getByRole("dialog", { name: "Produk etalase" });
    await items.getByRole("button", { name: "Tambah item" }).click();
    await items.getByLabel("Nilai item").fill("9007199254740993");
    await expect(items.getByRole("button", { name: "Simpan rincian" })).toBeInViewport();
    await items.getByRole("button", { name: "Simpan rincian" }).click();
    await dialog.getByRole("button", { name: "Berikutnya" }).click();
    expect(writes).toBe(0);
    await expect(dialog.getByRole("button", { name: "Setujui & kirim" })).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await expect(dialog.getByRole("button", { name: "Setujui & kirim" })).toBeInViewport();
    expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(size.height);
    await page.waitForTimeout(200);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await dialog.screenshot({ path: info.outputPath("commerce-confirmation.png") });
    await dialog.getByRole("button", { name: "Setujui & kirim" }).click();
    const result = page.getByRole("dialog", { name: "Hasil permintaan" });
    await expect(result.getByText("Diterima marketplace", { exact: true })).toBeVisible();
    await expect(
      result.locator('[data-slot="dialog-footer"]').getByRole("button", { name: "Tutup", exact: true }),
    ).toBeInViewport();
    await result.getByRole("tab", { name: "Rincian", exact: true }).click();
    await expect(result.getByText("17 Okt 2026, 08.00").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.waitForTimeout(200);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(writes).toBe(1);
  });
}

test("uploads a real multipart photo before submitting the creator operation", async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addCookies([{ name: "os_session", value: "commerce-file-ui-fixture", url: baseURL! }]);
  const principalId = "01JACCOUNT00000000000000001";
  const fileId = "01JFILE0000000000000000001";
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwX0AAAAASUVORK5CYII=",
    "base64",
  );
  const operation = {
    id: "tiktokshop.creator.photo.upload",
    channel: "tiktokshop",
    principalKind: "creator",
    title: "Unggah foto creator",
    group: "Konten creator",
    method: "POST",
    path: "/affiliate_creator/202509/images/upload",
    scopes: ["creator.video.write"],
    write: true,
    officialUrl: "https://partner.tiktokshop.com/",
    available: true,
    unavailableReason: null,
    requiredPermissions: [],
    fields: [
      {
        name: "body.data",
        label: "Foto creator",
        type: "file",
        required: true,
        accept: ["image/png"],
        maxBytes: 10485760,
      },
    ],
  };
  let uploaded = false;
  let submitted = false;
  const result = {
    id: "01JREQUEST0000000000000001",
    operationId: operation.id,
    principalId,
    principalKind: "creator",
    status: "succeeded",
    result: { data: { image_id: "123456789" }, nextCursor: null, acknowledgement: "accepted" },
    nextCursor: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-10-17T01:00:00Z",
    finishedAt: "2026-10-17T01:00:01Z",
    expiresAt: "2026-10-18T01:00:00Z",
  };
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
          name: "Demo",
          slug: "demo",
          timezone: "Asia/Jakarta",
          status: "active",
        },
        plan: { code: "growth", name: "Growth", features: [] },
        roles: [],
        permissions: ["commerce:read", "commerce:write"],
        storeScope: null,
        warehouseScope: null,
      };
    if (path === "/v1/commerce/operations") data = { items: [operation] };
    if (path === "/v1/commerce/principals")
      data = {
        items: [
          {
            id: principalId,
            kind: "creator",
            channel: "tiktokshop",
            name: "Candra",
            status: "active",
            scopes: ["creator.video.write"],
            region: "ID",
            readOnly: false,
            categories: [],
          },
        ],
      };
    if (path === "/v1/commerce/files") {
      expect(request.headers()["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
      expect(request.postDataBuffer()!.indexOf(png)).toBeGreaterThanOrEqual(0);
      const multipart = request.postDataBuffer()!.toString("utf8");
      expect(multipart).toContain(operation.id);
      expect(multipart).toContain(principalId);
      expect(multipart).toContain('filename="foto-candra.png"');
      expect(multipart).toContain("Content-Type: image/png");
      uploaded = true;
      data = {
        fileId,
        filename: "foto-candra.png",
        mime: "image/png",
        sizeBytes: png.length,
        expiresAt: "2026-10-18T01:00:00Z",
      };
    }
    if (path === "/v1/commerce/requests" && request.method() === "POST") {
      expect(uploaded).toBe(true);
      expect(request.postDataJSON()).toMatchObject({ input: { body: { data: fileId } }, confirmed: true });
      submitted = true;
      data = result;
    }
    if (path === `/v1/commerce/requests/${result.id}`) data = result;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto("/commerce");
  await page.getByRole("button", { name: "Buka: Unggah foto creator" }).click();
  const dialog = page.getByRole("dialog", { name: "Unggah foto creator" });
  await dialog.getByLabel("Foto creator").setInputFiles({
    name: "foto-candra.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(dialog.getByText("foto-candra.png", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Berikutnya" }).click();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Setujui & kirim" }).click();
  await expect(page.getByRole("dialog", { name: "Hasil permintaan" })).toBeVisible();
  expect(submitted).toBe(true);
});
