import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * The webhook process reads every body as raw bytes (technology doc 8.3): Shopee signs
 * url + "|" + body and TikTok Shop signs app_key + body, so JSON parsing and re-serializing would
 * break verification. Create the app with `bodyParser: false`, then call this.
 */
export function configureWebhookApp(app: NestExpressApplication): void {
  app.useBodyParser("raw", { type: () => true, limit: "2mb" });
}
