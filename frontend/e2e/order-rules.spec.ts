import AxeBuilder from "@axe-core/playwright";
import { call, expect, test } from "./fixtures";

test("keeps automatic order rules: made in the dialog, switched off, reordered, and deleted", async ({
  page,
  business,
}) => {
  void business;
  await call(page, "POST", "/v1/tags", { name: "Cek dulu", color: "#E34948" });
  // an agent the second rule prints to (paired through the api; it never reports, so it shows as cut off)
  await call(page, "POST", "/v1/print-agents", { name: "PC Packing" });

  await page.goto("/");
  await page.getByRole("link", { name: "Aturan Otomatis" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Aturan Otomatis" })).toBeVisible();
  await expect(page.getByText("Belum ada aturan")).toBeVisible();

  // nothing to do yet: the dialog says so before asking the api
  await page.getByRole("button", { name: "Buat aturan" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Aturan baru" });
  await dialog.getByLabel("Nama aturan").fill("Pesanan besar");
  await dialog.getByLabel("Total paling sedikit").fill("Rp 500.000");
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(dialog.getByText("Pilih paling sedikit satu tindakan.")).toBeVisible();
  await dialog.getByRole("group", { name: "Beri tag" }).getByLabel("Cek dulu").check();
  // the dialog after its fade-in (a fading dialog reads as low contrast)
  await page.waitForTimeout(300);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText("Aturan Pesanan besar disimpan.")).toBeVisible();

  // the second rule arranges pickup at a time of day and prints the label on the agent (M48)
  await page.getByRole("button", { name: "Buat aturan" }).first().click();
  const second = page.getByRole("dialog", { name: "Aturan baru" });
  await second.getByLabel("Nama aturan").fill("Satu barang");
  await second.locator("label", { hasText: "1 barang" }).click();
  await second.getByLabel("Terima dan atur pickup").check();
  // the segmented control's radios are sr-only: click the label
  await second.locator("label", { hasText: "Pada jam tertentu" }).click();
  await second.getByLabel("Jam (WIB)").fill("16:30");
  await second.getByRole("combobox", { name: "Agen cetak" }).click();
  await page.getByRole("option", { name: "PC Packing · terputus" }).click();
  await second.getByRole("switch", { name: "Sertakan daftar kemas" }).click();
  await second.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText("Aturan Satu barang disimpan.")).toBeVisible();

  const list = page.getByRole("list", { name: "Aturan, urut seperti diperiksa" });
  await expect(list.getByRole("listitem").first()).toContainText("Jika: total paling sedikit Rp 500.000");
  await expect(list.getByRole("listitem").first()).toContainText("Maka: beri tag Cek dulu");
  await expect(list.getByRole("listitem").nth(1)).toContainText("Jika: 1 barang");
  await expect(list.getByRole("listitem").nth(1)).toContainText(
    "Maka: terima, atur pickup pukul 16.30 → cetak label ke PC Packing",
  );

  // the single-item rule goes first, and the big one is switched off
  await page.getByRole("button", { name: "Naikkan urutan Satu barang" }).click();
  await expect(list.getByRole("heading").first()).toHaveText("Urutan 1:Satu barang");
  await page.getByRole("switch", { name: "Aktifkan aturan Pesanan besar" }).click();
  await expect(page.getByText("Aturan Pesanan besar dimatikan.")).toBeVisible();
  await expect(list.getByRole("listitem").nth(1)).toContainText("Mati");
  const rules = await call<{
    items: { name: string; priority: number; active: boolean; actions: { arrangeAt: string | null; print: unknown } }[];
  }>(page, "GET", "/v1/order-rules");
  expect(rules.items.map((r) => [r.name, r.priority, r.active])).toEqual([
    ["Satu barang", 1, true],
    ["Pesanan besar", 2, false],
  ]);
  expect(rules.items[0]!.actions).toMatchObject({
    arrangeAt: "16:30",
    print: { format: "thermal", template: "standard", packingList: true },
  });

  await page.getByRole("button", { name: "Hapus aturan Pesanan besar" }).click();
  await page
    .getByRole("dialog", { name: "Hapus aturan Pesanan besar?" })
    .getByRole("button", { name: "Hapus" })
    .click();
  await expect(page.getByText("Aturan Pesanan besar dihapus.")).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(1);

  // the audit log names who made and changed the rules
  await page.goto("/log-audit");
  await expect(page.getByText("Membuat aturan otomatis").first()).toBeVisible();
  await expect(page.getByText("Menghapus aturan otomatis").first()).toBeVisible();
});
