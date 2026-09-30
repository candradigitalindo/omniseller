import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envSchema, InvalidEnvError, parseEnv } from "./env.schema";

const common = {
  NODE_ENV: "test",
  REDIS_QUEUE_URL: "redis://localhost:6379",
  REDIS_CACHE_URL: "redis://localhost:6380",
};

describe("parseEnv", () => {
  it("parses the api role with defaults", () => {
    const env = parseEnv({
      ...common,
      APP_ROLE: "api",
      DATABASE_URL: "postgres://a@localhost/db",
      PUBLIC_WEB_URL: "http://localhost:3100",
    });
    expect(env).toMatchObject({ APP_ROLE: "api", PORT: 3000, LOG_LEVEL: "info" });
  });

  it("requires the worker database URL for the worker role", () => {
    expect(() => parseEnv({ ...common, APP_ROLE: "worker", DATABASE_URL: "postgres://a@localhost/db" })).toThrow(
      /DATABASE_URL_WORKER/,
    );
  });

  it("requires both worker and system URLs for the scheduler", () => {
    const env = parseEnv({
      ...common,
      APP_ROLE: "scheduler",
      DATABASE_URL_WORKER: "postgres://w@localhost/db",
      DATABASE_URL_SYSTEM: "postgres://s@localhost/db",
    });
    expect(env.APP_ROLE).toBe("scheduler");
  });

  it("documents every key in .env.example (backend doc 5.1)", () => {
    const example = readFileSync(join(__dirname, "../../.env.example"), "utf8");
    const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const optionalOnly = new Set(["OTEL_EXPORTER_OTLP_ENDPOINT", "SENTRY_DSN", "APP_ROLE", "PORT"]);
    const keys = new Set(envSchema.options.flatMap((o) => Object.keys(o.shape)));
    const missing = [...keys].filter((k) => !documented.has(k) && !optionalOnly.has(k));
    expect(missing).toEqual([]);
  });

  it("refuses email transports that would leak links outside local and test", () => {
    const worker = {
      ...common,
      APP_ROLE: "worker",
      DATABASE_URL_WORKER: "postgres://w@localhost/db",
      PUBLIC_WEB_URL: "http://localhost:3100",
    };
    expect(() => parseEnv({ ...worker, NODE_ENV: "production", EMAIL_TRANSPORT: "log" })).toThrow(
      /only allowed when NODE_ENV=local/,
    );
    expect(() => parseEnv({ ...worker, NODE_ENV: "staging", EMAIL_TRANSPORT: "memory" })).toThrow(/NODE_ENV=test/);
    expect(() => parseEnv({ ...worker, NODE_ENV: "staging" })).toThrow(/SMTP_URL/);
    expect(parseEnv({ ...worker, NODE_ENV: "staging", SMTP_URL: "smtp://ses:587" }).APP_ROLE).toBe("worker");
  });

  it("rejects an unknown role with a readable message", () => {
    expect(() => parseEnv({ ...common, APP_ROLE: "cron" })).toThrow(InvalidEnvError);
    expect(() => parseEnv({ ...common })).toThrow(/APP_ROLE must be one of/);
  });
});
