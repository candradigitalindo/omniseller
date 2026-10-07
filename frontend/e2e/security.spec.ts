import { createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** What an authenticator app shows for `secret` at `ms` (RFC 6238: SHA-1, 6 digits, 30 seconds). */
function totp(secret: string, ms = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.replace(/\s/g, "")].map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

/** Serious or critical axe findings inside the open dialog or page, after its entrance animation. */
async function axeProblems(page: Page, include?: string): Promise<string[]> {
  await page.waitForTimeout(400);
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
  const result = await (include ? builder.include(include) : builder).analyze();
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

async function signInWithPassword(page: Page, email: string, password: string) {
  await page.request.post("/v1/auth/logout");
  await page.goto("/masuk");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page.getByRole("heading", { name: "Verifikasi dua langkah" })).toBeVisible();
}

test("turns on two-step verification, then signs in with a code from the app and with a backup code", async ({
  page,
  business,
}) => {
  await page.goto("/akun");
  await expect(page.getByText("Belum aktif")).toBeVisible();
  await page.getByRole("button", { name: "Aktifkan" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Kata sandi").fill(business.password);
  await dialog.getByRole("button", { name: "Lanjut" }).click();
  await expect(dialog.getByRole("img", { name: "Kode QR untuk aplikasi autentikator" })).toBeVisible();
  expect(await axeProblems(page, '[role="dialog"]')).toEqual([]);
  const secret = (await dialog.locator("code").innerText()).replace(/\s/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await dialog.getByLabel("Kode 6 angka dari aplikasi").pressSequentially(totp(secret));

  const codes = dialog.getByRole("list", { name: "Kode cadangan" }).getByRole("listitem");
  await expect(codes).toHaveCount(10);
  const backupCode = await codes.first().innerText();
  await dialog.getByLabel("Saya sudah menyimpan kode ini").check();
  await dialog.getByRole("button", { name: "Selesai" }).click();
  await expect(page.getByText("Aktif", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Perangkat yang masuk" })).toContainText("Perangkat ini");

  // the password alone no longer signs in; the app's next code does (the one that turned it on was used)
  await signInWithPassword(page, business.email, business.password);
  expect(await axeProblems(page)).toEqual([]);
  await page.getByLabel("Kode verifikasi").pressSequentially(totp(secret, Date.now() + 30_000));
  await page.waitForURL((url) => url.pathname === "/");

  // a lost phone: a backup code, once
  await signInWithPassword(page, business.email, business.password);
  await page.getByRole("button", { name: "Pakai kode cadangan" }).click();
  await page.getByLabel("Kode cadangan").fill(backupCode);
  await page.getByRole("button", { name: "Verifikasi" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByText(/Anda masuk dengan kode cadangan\. Sisa 9 kode/)).toBeVisible();
  await page.goto("/akun");
  await expect(page.getByText("Sisa kode cadangan: 9")).toBeVisible();
});
