import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * HTTP settings of the api process beyond NestJS defaults.
 * - JSON bodies up to 12 MB: product CSV imports (FR-PRD-04) are sent as JSON and a 10 000-row file is a
 *   few megabytes.
 * - No conditional GETs, and answers are never stored (`Cache-Control: no-store`): they hold the
 *   business's and its buyers' data, and an ETag here is a row's version for If-Match, not a cache
 *   validator. A browser that kept the business profile sent `If-None-Match` with its version and Express
 *   answered 304, so the documents added since (rows of their own, the profile's version unchanged) never
 *   showed. Express's own ETags are off, and an `If-None-Match` a client sends is dropped.
 */
export function configureApiApp(app: NestExpressApplication): void {
  app.useBodyParser("json", { limit: "12mb" });
  app.set("etag", false);
  app.use(
    (
      req: { headers: Record<string, unknown> },
      res: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      delete req.headers["if-none-match"];
      res.setHeader("Cache-Control", "no-store");
      next();
    },
  );
}
