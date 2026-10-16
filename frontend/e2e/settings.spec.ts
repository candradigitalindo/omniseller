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
  // the invitation's row, not the toast that also names the address
  await expect(page.getByText(email, { exact: true })).toBeVisible();

  await page.goto("/ekspor");
  await page.getByRole("button", { name: "Buat ekspor" }).click();
  const download = page.getByRole("link", { name: "Unduh ZIP" });
  await expect(download).toBeVisible({ timeout: 60_000 });
  const zip = await page.request.get((await download.getAttribute("href")) ?? "");
  expect(zip.headers()["content-type"]).toContain("application/zip");

  // the weekly sales report email is a personal choice (L44), off until chosen; the team report is on the trial too
  await page.goto("/notifikasi");
  const weekly = page.getByRole("switch", { name: /Email untuk Laporan penjualan mingguan/ });
  await expect(weekly).not.toBeChecked();
  await weekly.click();
  await expect(page.getByText("Email diaktifkan.")).toBeVisible();
  await expect(weekly).toBeChecked();
  await expect(weekly.locator("xpath=ancestor::tr")).toContainText("Bersama email");
  await expect(page.getByRole("switch", { name: /Email untuk Laporan kinerja tim mingguan/ })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("switch", { name: /Email untuk Laporan penjualan mingguan/ })).toBeChecked();
});

test("on Starter creates and edits a custom role, invites with it, and deletes it once nothing needs it", async ({
  page,
  business,
}) => {
  void business;
  const name = `Packer ${tag()}`;
  const email = `packer-${tag().toLowerCase()}@example.test`;
  const down = await page.request.post("/v1/billing/subscription", { data: { planCode: "starter" } });
  expect(down.status(), await down.text()).toBe(200);
  await page.goto("/tim?tab=peran");
  await page.getByRole("button", { name: "Buat peran" }).click();
  const dialog = page.getByRole("dialog", { name: "Buat peran" });
  await dialog.getByLabel("Nama peran").fill(name);
  // Gudang's nine permissions, less the courier handover
  await dialog.getByRole("combobox", { name: "Salin izin dari" }).click();
  await page.getByRole("option", { name: "Gudang" }).click();
  await dialog.getByRole("checkbox", { name: /Serah terima kurir/ }).click();
  await expect(dialog.getByText("8 izin dipilih")).toBeVisible();
  await dialog.getByRole("button", { name: "Buat peran" }).click();
  const custom = page.getByRole("list", { name: "Peran kustom" });
  await expect(custom.getByText(name)).toBeVisible();
  await expect(custom.getByText("8 izin · belum ada pemegang")).toBeVisible();
  await expect(page.getByRole("columnheader", { name })).toBeVisible();

  await page.getByRole("button", { name: `Ubah peran ${name}` }).click();
  const edit = page.getByRole("dialog", { name: `Ubah peran ${name}` });
  await edit.getByRole("searchbox", { name: "Cari izin" }).fill("Terima pesanan");
  await edit.getByRole("checkbox", { name: "Terima pesanan" }).check();
  await edit.getByLabel("Keterangan (opsional)").fill("Tim toko pada paket Starter");
  await edit.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(custom.getByText("Tim toko pada paket Starter")).toBeVisible();

  await page.getByRole("button", { name: "Undang anggota" }).click();
  const invite = page.getByRole("dialog", { name: "Undang anggota" });
  await invite.getByLabel("Email").fill(email);
  await invite.getByRole("combobox", { name: "Peran" }).click();
  await page.getByRole("option", { name }).click();
  await invite.getByRole("button", { name: "Kirim undangan" }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();

  // the open invitation still offers it
  await page.getByRole("tab", { name: "Peran" }).click();
  await page.getByRole("button", { name: `Hapus peran ${name}` }).click();
  const refused = page.getByRole("dialog", { name: `Hapus peran ${name}?` });
  await refused.getByRole("button", { name: "Hapus peran" }).click();
  await expect(refused.getByRole("alert")).toContainText("1 undangan terbuka");
  await refused.getByRole("button", { name: "Batal" }).click();

  await page.getByRole("tab", { name: "Undangan" }).click();
  await page.getByRole("button", { name: "Batalkan" }).click();
  await expect(page.getByText(email, { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Peran" }).click();
  await page.getByRole("button", { name: `Hapus peran ${name}` }).click();
  await page
    .getByRole("dialog", { name: `Hapus peran ${name}?` })
    .getByRole("button", { name: "Hapus peran" })
    .click();
  await expect(page.getByText("Belum ada peran kustom.")).toBeVisible();
});
