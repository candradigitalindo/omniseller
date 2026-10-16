import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test",
  testMatch: "desktop.e2e.ts",
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
