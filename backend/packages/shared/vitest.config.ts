import { defineConfig } from "vitest/config";

// Own config so vitest does not pick up the backend root config (and its database global setup).
export default defineConfig({
  test: { name: "shared", include: ["src/**/*.spec.ts"] },
});
