import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** An invoice's PDF from the history table, as the browser saves it. */
async function savePdf(page: Page, number: string): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("table", { name: "Riwayat tagihan" })
      .getByRole("link", { name: `Unduh PDF tagihan ${number}` })
      .click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${number}.pdf`);
  const bytes = await readFile((await download.path()) ?? "");
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  return bytes;
}

test("shows the Growth trial with its quotas, and steps down to Starter at once", async ({ page, business }) => {
  void business;
  await page.goto("/langganan");
  await expect(page.getByRole("heading", { level: 1, name: "Langganan & Tagihan" })).toBeVisible();
  const current = page.getByTestId("current-plan");
  await expect(current).toContainText("Paket Growth");
  await expect(current).toContainText("Uji coba");
  await expect(current).toContainText(/Uji coba gratis berakhir .* \(1[34] hari lagi\)/);
  // the first warehouse against Growth's two, the Owner against ten seats
  await expect(page.getByRole("progressbar", { name: "Gudang: 1 dari 2" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Pengguna: 1 dari 10" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Paket saat ini" })).toHaveCount(0);
  await expect(page.getByText("Belum ada tagihan.")).toBeVisible();

  // the free plan from a trial: at once, with its quotas spelled out first
  await page.getByRole("button", { name: "Turun ke Starter" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "2 toko marketplace, 1 gudang, 1.000 pesanan per bulan, 2 pengguna mulai sekarang",
  );
  await dialog.getByRole("button", { name: "Ya, turun ke Starter" }).click();
  await expect(page.getByText("Bisnis kini memakai paket Starter.")).toBeVisible();
  await expect(current).toContainText("Paket Starter");
  await expect(current).toContainText("Gratis");
  await expect(current).toContainText("Paket gratis tanpa periode.");
  await expect(page.getByRole("progressbar", { name: "Gudang: 1 dari 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Paket saat ini" })).toBeDisabled();
  // a second warehouse is now one too many (backend doc 8.32)
  const refused = await page.request.post("/v1/warehouses", { data: { code: "DUA", name: "Gudang Dua" } });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).code).toBe("billing.limit_reached");
  // the sidebar leads here for the Owner
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Langganan & Tagihan" }).first()).toBeVisible();
});

test("pays for Growth on Xendit's page and keeps the invoice as PDF, waiting and paid", async ({ page, business }) => {
  test.skip(
    !process.env.E2E_FAKE_XENDIT,
    "needs the fake Xendit behind the backend: pnpm mock:xendit, E2E_FAKE_XENDIT=1",
  );
  void business;
  await page.goto("/langganan");
  await page.getByRole("button", { name: "Berlangganan Growth" }).click();
  // the worker asks Xendit for the payment page; the screen polls until it is there
  const pay = page.getByRole("status", { name: "Tagihan menunggu dibayar" }).getByRole("link", { name: /^Bayar INV-/ });
  await expect(pay).toBeVisible({ timeout: 30_000 });
  const number = ((await pay.getAttribute("aria-label")) ?? "").replace(/^Bayar /, "");
  await expect(page.getByText(/^PDF tagihan memuat nama, alamat, dan NPWP bisnis/)).toBeVisible();
  await savePdf(page, number);

  // Xendit's page in test mode: pay, and back to OmniSeller
  await pay.click();
  await expect(page.getByRole("heading", { name: "Pembayaran (mode uji)" })).toBeVisible();
  await page.getByRole("button", { name: "Bayar (simulasi)" }).click();
  await expect(page.getByText(/^Terima kasih\. Paket aktif begitu Xendit mengonfirmasi pembayaran/)).toBeVisible();
  await expect(page).toHaveURL(/\/langganan$/);
  // the callback reaches the webhook process and the worker; the page polls while the invoice waits
  const history = page.getByRole("table", { name: "Riwayat tagihan" });
  await expect(history.getByText("Lunas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("current-plan")).toContainText("Bulan setelahnya sudah dibayar");
  await savePdf(page, number);

  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
