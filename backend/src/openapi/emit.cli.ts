import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { parseEnv } from "../config/env.schema";
import { buildOpenApiDocument } from "./document";

/**
 * `pnpm openapi:emit`: writes openapi.json (committed; CI diffs it, backend doc 10.4).
 * Runs from the tsc build because the document depends on decorator metadata. Connections are
 * created lazily and never opened here.
 */
async function main(): Promise<void> {
  const env = parseEnv({
    APP_ROLE: "api",
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
    REDIS_QUEUE_URL: "redis://127.0.0.1:1",
    REDIS_CACHE_URL: "redis://127.0.0.1:1",
    PUBLIC_WEB_URL: "http://localhost:3100",
  });
  const app = await NestFactory.create(AppModule.forEnv(env), { logger: false, abortOnError: false });
  const doc = buildOpenApiDocument(app);
  const out = resolve(__dirname, "../../openapi.json");
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  await app.close().catch(() => {});
  process.stdout.write(`wrote ${out} (${Object.keys(doc.paths).length} paths)\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
