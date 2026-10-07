import { expect, test } from "./fixtures";

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
