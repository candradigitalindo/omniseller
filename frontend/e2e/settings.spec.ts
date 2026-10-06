import { expect, tag, test } from "./fixtures";

test("adds a warehouse, renames it, and deletes it while it is empty", async ({ page, business }) => {
  void business;
  const code = `G${tag()}`;
  await page.goto("/stok/gudang");
  await page.getByRole("button", { name: "Tambah gudang" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Kode", { exact: true }).fill(code.toLowerCase());
  await dialog.getByLabel("Nama gudang").fill("Gudang Bandung");
  await dialog.getByRole("combobox", { name: "Provinsi" }).click();
  await page.getByRole("option", { name: "Jawa Barat" }).click();
  await dialog.getByRole("button", { name: "Simpan" }).click();
  const card = page.locator("[data-slot=card]", { hasText: code });
  await expect(card.getByText("Gudang Bandung")).toBeVisible();

  await card.getByRole("button", { name: "Ubah" }).click();
  await page.getByRole("dialog").getByLabel("Nama gudang").fill("Gudang Bandung Kota");
  await page.getByRole("dialog").getByRole("button", { name: "Simpan" }).click();
  await expect(card.getByText("Gudang Bandung Kota")).toBeVisible();

  await card.getByRole("button", { name: "Hapus" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Hapus" }).click();
  await expect(page.locator("[data-slot=card]", { hasText: code })).toHaveCount(0);
});

test("invites a team member and exports all data", async ({ page, business }) => {
  void business;
  const email = `anggota-${tag().toLowerCase()}@example.test`;
  await page.goto("/tim");
  await page.getByRole("button", { name: "Undang anggota" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByRole("combobox", { name: "Peran" }).click();
  await page.getByRole("option", { name: "Gudang" }).click();
  await dialog.getByRole("button", { name: "Kirim undangan" }).click();
  await expect(page.getByText(email)).toBeVisible();

  await page.goto("/ekspor");
  await page.getByRole("button", { name: "Buat ekspor" }).click();
  const download = page.getByRole("link", { name: "Unduh ZIP" });
  await expect(download).toBeVisible({ timeout: 60_000 });
  const zip = await page.request.get((await download.getAttribute("href")) ?? "");
  expect(zip.headers()["content-type"]).toContain("application/zip");
});
