import { call, expect, seedShop, tag, test } from "./fixtures";

test("sets a courier's last pickup, and the order to ship counts down to it", async ({ page, business }) => {
  void business;
  const shop = await seedShop(page, tag());

  await page.goto("/kurir-jam");
  await expect(page.getByText("Belum ada cut-off kurir")).toBeVisible();
  await page.getByRole("button", { name: "Tambah cut-off" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Tambah cut-off kurir" });
  await dialog.getByLabel("Kurir").fill("J&T Express");
  await dialog.getByLabel("Jam cut-off").fill("23:59");
  // every day, so the pickup is today wherever the test runs
  await dialog.getByLabel("Min").check();
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText("Cut-off J&T Express disimpan.")).toBeVisible();
  await expect(page.getByRole("list", { name: /^Cut-off / })).toContainText("Pickup terakhir 23.59 · Setiap hari");

  // the worker gives the order waiting for J&T its pickup
  await expect
    .poll(
      async () =>
        (await call<{ internalShipByAt: string | null }>(page, "GET", `/v1/orders/${shop.order.id}`)).internalShipByAt,
    )
    .not.toBeNull();
  await page.goto("/pesanan?status=new");
  await expect(page.getByText(/^Pickup (\d+ \w+ )?23\.59 · /).first()).toBeVisible();

  // a courier holiday and the business's hours, on their own tabs
  await page.goto("/kurir-jam?tab=libur");
  await page.getByRole("button", { name: "Tambah hari libur" }).click();
  const holiday = page.getByRole("dialog", { name: "Tambah hari libur kurir" });
  await holiday.getByLabel("Tanggal").fill("2026-12-25");
  await holiday.getByLabel("Catatan (opsional)").fill("Natal");
  await holiday.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByRole("list", { name: "Hari libur kurir" })).toContainText("Jumat, 25 Des 2026");

  await page.goto("/kurir-jam?tab=jam");
  await page.getByRole("button", { name: "Atur jam operasional" }).click();
  await page.getByRole("button", { name: "Simpan jam operasional" }).click();
  await expect(page.getByText("Jam operasional disimpan.")).toBeVisible();
});
