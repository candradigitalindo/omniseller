import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * HTTP settings of the api process beyond NestJS defaults. JSON bodies up to 12 MB: product CSV
 * imports (FR-PRD-04) are sent as JSON and a 10 000-row file is a few megabytes.
 */
export function configureApiApp(app: NestExpressApplication): void {
  app.useBodyParser("json", { limit: "12mb" });
}
