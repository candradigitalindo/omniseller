import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (DOKUMEN-TEKNOLOGI 20): the built web app against a running backend. Locally start the
 * backend (`pnpm dev` in backend/) and the web app (`pnpm build && pnpm start`), then `pnpm e2e`; with
 * `E2E_CHROME=1` the installed Google Chrome is used instead of a downloaded Chromium. `E2E_BASE_URL`
 * points the tests at another deployment (staging).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    locale: "id-ID",
    timezoneId: "Asia/Jakarta",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...(process.env.E2E_CHROME ? { channel: "chrome" } : {}) },
    },
  ],
});
