import { expect, test } from "./fixtures";

test("fills the business profile, renames the business, and keeps a legal document with its validity", async ({
  page,
  business,
}) => {
  await page.goto("/profil-bisnis");
  await expect(page.getByText(/NIB wajib bagi penjual di marketplace/)).toBeVisible();

  const name = page.getByLabel("Nama bisnis");
  await name.fill(`${business.name} Jaya`);
  await page.getByRole("group", { name: "NIB (Nomor Induk Berusaha)" }).getByText("Sudah punya").click();
  await page.getByLabel("Nomor NIB").fill("1234 5678 90123");
  await page.getByLabel("NPWP").fill("123456789012000");
  await page.getByRole("button", { name: "Simpan perubahan" }).click();
  await expect(page.getByText("Profil bisnis disimpan.")).toBeVisible();
  await expect(page.getByText(/NIB wajib bagi penjual/)).toHaveCount(0);
  await expect(page.getByLabel("NPWP")).toHaveValue("12.345.678.9-012.000");
  // the new name is the business's everywhere, the profile menu included
  await page.getByRole("button", { name: "Rina Wulandari" }).first().click();
  await expect(page.getByRole("menu")).toContainText(`${business.name} Jaya`);
  await page.keyboard.press("Escape");

  const until = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  await page.getByRole("button", { name: "Unggah dokumen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Jenis dokumen" }).click();
  await page.getByRole("option", { name: "Izin usaha" }).click();
  await dialog.getByLabel("Berlaku sampai").fill(until);
  await dialog.getByLabel("Berkas").setInputFiles({
    name: "izin.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
  });
  await dialog.getByRole("button", { name: "Unggah dokumen" }).click();
  const list = page.getByRole("list", { name: "Dokumen legalitas" });
  await expect(list).toContainText("Izin usaha");
  await expect(list).toContainText(/Habis dalam (9|10) hari/);
  const file = await page.request.get(
    (await list.getByRole("link", { name: "Lihat Izin usaha" }).getAttribute("href")) ?? "",
  );
  expect(file.headers()["content-type"]).toContain("pdf");
});
