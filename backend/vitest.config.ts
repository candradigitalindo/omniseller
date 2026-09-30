import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC emits decorator metadata, which NestJS and the nestjs-zod validation pipe read at runtime.
// DTO classes must therefore be imported as values, never with `type` (see src/common/http/dto-metadata.spec.ts).
const plugins = [swc.vite({ module: { type: "es6" } })];

export default defineConfig({
  test: {
    projects: [
      {
        plugins,
        test: {
          name: "unit",
          include: ["src/**/*.spec.ts"],
          exclude: ["src/**/*.int.spec.ts"],
        },
      },
      {
        plugins,
        test: {
          name: "integration",
          include: ["src/**/*.int.spec.ts", "test/**/*.int.spec.ts"],
          globalSetup: ["test/setup/global-setup.ts"],
          // One PostgreSQL database per run; files share it, so they run one at a time.
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
