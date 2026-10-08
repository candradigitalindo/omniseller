import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envSchema, InvalidEnvError, parseEnv } from "./env.schema";

const common = {
  NODE_ENV: "test",
  REDIS_QUEUE_URL: "redis://localhost:6379",
  REDIS_CACHE_URL: "redis://localhost:6380",
};
/** Cloudflare R2, the default file storage. */
const r2 = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" };
/** The api's key for TOTP secrets (backend doc 8.30). */
const totp = { TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") };

describe("parseEnv", () => {
  it("parses the api role with defaults", () => {
    const env = parseEnv({
      ...common,
      APP_ROLE: "api",
      DATABASE_URL: "postgres://a@localhost/db",
      PUBLIC_WEB_URL: "http://localhost:3100",
      ...r2,
      ...totp,
    });
    expect(env).toMatchObject({
      APP_ROLE: "api",
      TOTP_ISSUER: "OmniSeller",
      PORT: 3000,
      LOG_LEVEL: "info",
      FILE_STORAGE: "r2",
      R2_BUCKET_DOCUMENTS: "omniseller-documents",
    });
  });

  it("prints OmniSeller as the invoice issuer unless told otherwise, with the NPWP as digits", () => {
    const api = {
      ...common,
      APP_ROLE: "api",
      DATABASE_URL: "postgres://a@localhost/db",
      PUBLIC_WEB_URL: "http://localhost:3100",
      ...r2,
      ...totp,
    };
    const plain = parseEnv({ ...api, BILLING_ISSUER_ADDRESS: "", BILLING_ISSUER_NPWP: "" });
    expect(plain).toMatchObject({ BILLING_ISSUER_NAME: "OmniSeller" });
    expect(plain).not.toHaveProperty("BILLING_ISSUER_NPWP");
    expect(plain).not.toHaveProperty("BILLING_ISSUER_ADDRESS");
    const named = parseEnv({
      ...api,
      BILLING_ISSUER_NAME: "PT Contoh Niaga Digital",
      BILLING_ISSUER_NPWP: "01.234.567.8-901.000",
      BILLING_ISSUER_EMAIL: "tagihan@omniseller.id",
    });
    expect(named).toMatchObject({
      BILLING_ISSUER_NAME: "PT Contoh Niaga Digital",
      BILLING_ISSUER_NPWP: "012345678901000",
    });
    expect(() => parseEnv({ ...api, BILLING_ISSUER_NPWP: "12.345" })).toThrow(/BILLING_ISSUER_NPWP: must be 15 or 16/);
    expect(() => parseEnv({ ...api, BILLING_ISSUER_EMAIL: "tagihan" })).toThrow(/BILLING_ISSUER_EMAIL/);
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
      PUBLIC_WEBHOOK_URL: "https://hooks.omniseller.id",
      KMS_KEY_ID_TOKENS: "alias/omniseller-tokens",
      AWS_REGION: "ap-southeast-3",
      ...r2,
    };
    expect(() => parseEnv({ ...worker, NODE_ENV: "production", EMAIL_TRANSPORT: "log" })).toThrow(
      /only allowed when NODE_ENV=local/,
    );
    expect(() => parseEnv({ ...worker, NODE_ENV: "staging", EMAIL_TRANSPORT: "memory" })).toThrow(/NODE_ENV=test/);
    expect(() => parseEnv({ ...worker, NODE_ENV: "staging" })).toThrow(/SMTP_URL/);
    expect(parseEnv({ ...worker, NODE_ENV: "staging", SMTP_URL: "smtp://ses:587" }).APP_ROLE).toBe("worker");
  });

  it("guards marketplace token encryption and marketplace key pairs", () => {
    const worker = {
      ...common,
      APP_ROLE: "worker",
      DATABASE_URL_WORKER: "postgres://w@localhost/db",
      PUBLIC_WEB_URL: "http://localhost:3100",
      PUBLIC_WEBHOOK_URL: "https://hooks.omniseller.id",
      EMAIL_TRANSPORT: "memory",
      ...r2,
    };
    const key = Buffer.alloc(32, 7).toString("base64");
    // aws_kms is the default and needs its key and region
    expect(() => parseEnv(worker)).toThrow(/KMS_KEY_ID_TOKENS/);
    expect(parseEnv({ ...worker, TOKEN_KEY_PROVIDER: "local", TOKEN_LOCAL_MASTER_KEY: key }).APP_ROLE).toBe("worker");
    expect(() => parseEnv({ ...worker, TOKEN_KEY_PROVIDER: "local", TOKEN_LOCAL_MASTER_KEY: "c2hvcnQ=" })).toThrow(
      /32 random bytes/,
    );
    expect(() =>
      parseEnv({
        ...worker,
        NODE_ENV: "production",
        EMAIL_TRANSPORT: "smtp",
        SMTP_URL: "smtp://x",
        TOKEN_KEY_PROVIDER: "local",
        TOKEN_LOCAL_MASTER_KEY: key,
      }),
    ).toThrow(/use aws_kms/);
    const local = { ...worker, TOKEN_KEY_PROVIDER: "local", TOKEN_LOCAL_MASTER_KEY: key };
    expect(() => parseEnv({ ...local, SHOPEE_PARTNER_ID: "2001887" })).toThrow(/SHOPEE_PARTNER_KEY/);
    expect(() => parseEnv({ ...local, TIKTOKSHOP_APP_KEY: "k" })).toThrow(/TIKTOKSHOP_APP_SECRET/);
    // empty values in an env file mean "not set"
    expect(parseEnv({ ...local, SHOPEE_PARTNER_ID: "", SHOPEE_PARTNER_KEY: "" }).APP_ROLE).toBe("worker");
  });

  it("gives the api process marketplace ids but never secrets", () => {
    const env = parseEnv({
      ...common,
      APP_ROLE: "api",
      DATABASE_URL: "postgres://a@localhost/db",
      PUBLIC_WEB_URL: "http://localhost:3100",
      SHOPEE_PARTNER_ID: "2001887",
      SHOPEE_PARTNER_KEY: "must-not-appear",
      TIKTOKSHOP_APP_SECRET: "must-not-appear",
      ...r2,
      ...totp,
    });
    expect(env).toMatchObject({ SHOPEE_PARTNER_ID: 2001887 });
    expect(env).not.toHaveProperty("SHOPEE_PARTNER_KEY");
    expect(env).not.toHaveProperty("TIKTOKSHOP_APP_SECRET");
  });

  it("keeps files in R2 outside local and test, and needs its keys", () => {
    const api = {
      ...common,
      APP_ROLE: "api",
      DATABASE_URL: "postgres://a@localhost/db",
      PUBLIC_WEB_URL: "http://localhost:3100",
      ...totp,
    };
    expect(() => parseEnv(api)).toThrow(/R2_ACCESS_KEY_ID/);
    expect(parseEnv({ ...api, FILE_STORAGE: "local" })).toMatchObject({ FILE_STORAGE_LOCAL_DIR: ".local/files" });
    expect(() => parseEnv({ ...api, NODE_ENV: "production", FILE_STORAGE: "local" })).toThrow(/use r2/);
    // MinIO locally: an endpoint instead of the R2 account
    const minio = { R2_ENDPOINT: "http://127.0.0.1:9000", R2_ACCESS_KEY_ID: "minio", R2_SECRET_ACCESS_KEY: "minio123" };
    expect(parseEnv({ ...api, NODE_ENV: "local", ...minio })).toMatchObject({ FILE_STORAGE: "r2" });
  });

  it("needs a 32-byte TOTP key for the api, and never gives it to the worker", () => {
    const api = {
      ...common,
      APP_ROLE: "api",
      DATABASE_URL: "postgres://a@localhost/db",
      PUBLIC_WEB_URL: "http://localhost:3100",
      ...r2,
    };
    expect(() => parseEnv(api)).toThrow(/TOTP_ENCRYPTION_KEY: required/);
    expect(() => parseEnv({ ...api, TOTP_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/TOTP_ENCRYPTION_KEY: must be 32/);
    expect(parseEnv({ ...api, ...totp, TOTP_ISSUER: "OmniSeller Staging" })).toMatchObject({
      TOTP_ISSUER: "OmniSeller Staging",
    });
    const worker = parseEnv({
      ...common,
      APP_ROLE: "worker",
      DATABASE_URL_WORKER: "postgres://w@localhost/db",
      PUBLIC_WEB_URL: "http://localhost:3100",
      PUBLIC_WEBHOOK_URL: "https://hooks.omniseller.test",
      EMAIL_TRANSPORT: "memory",
      TOKEN_KEY_PROVIDER: "local",
      TOKEN_LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      FILE_STORAGE: "local",
      ...totp,
    });
    expect(worker).not.toHaveProperty("TOTP_ENCRYPTION_KEY");
  });

  it("rejects an unknown role with a readable message", () => {
    expect(() => parseEnv({ ...common, APP_ROLE: "cron" })).toThrow(InvalidEnvError);
    expect(() => parseEnv({ ...common })).toThrow(/APP_ROLE must be one of/);
  });
});
