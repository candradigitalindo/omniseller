import { z } from "zod";

/**
 * Environment per process role (backend doc 5.2). Read once at startup; the process fails fast with a
 * readable message when a value is missing. Each role declares only what it uses: api never receives
 * marketplace secrets or the worker/system database URLs.
 */
export const APP_ROLES = ["api", "webhook", "worker", "scheduler", "research-collector"] as const;
export type AppRole = (typeof APP_ROLES)[number];

const base = z.object({
  NODE_ENV: z.enum(["local", "test", "staging", "production"]),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  REDIS_QUEUE_URL: z.url(),
  REDIS_CACHE_URL: z.url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  SENTRY_DSN: z.string().optional(),
});

/** omniseller_api: RLS enforced, cannot read marketplace tokens. */
const apiRoleDb = { DATABASE_URL: z.url() };
/** omniseller_worker: RLS enforced, may read tokens. */
const workerRoleDb = { DATABASE_URL_WORKER: z.url() };
/** omniseller_system: BYPASSRLS, registered cross-tenant scheduler jobs only. */
const systemRoleDb = { DATABASE_URL_SYSTEM: z.url() };

/** Origin of the web app: CORS allow-list for the API, and the base of links in emails. */
const publicWebUrl = { PUBLIC_WEB_URL: z.url() };

/**
 * Public origin of the webhook process (https://hooks.omniseller.id). Shopee signs the full callback
 * URL, and TikTok Shop shops are subscribed to `${PUBLIC_WEBHOOK_URL}/webhooks/tiktokshop`.
 */
const publicWebhookUrl = { PUBLIC_WEBHOOK_URL: z.url() };

/**
 * Marketplace apps (technology doc 26.2). A channel whose keys are absent is "not configured": the API
 * lists it as unavailable and refuses to start a connection. Each process gets only what it uses:
 * api builds authorization links (public ids only), webhook verifies signatures, worker calls the APIs.
 */
const shopeeLink = {
  SHOPEE_PARTNER_ID: z.coerce.number().int().positive().optional(),
  SHOPEE_AUTH_BASE_URL: z.url().default("https://open.shopee.com"),
};
const shopeeSecret = { SHOPEE_PARTNER_KEY: z.string().min(8).optional() };
const shopeeApi = { SHOPEE_API_BASE_URL: z.url().default("https://partner.shopeemobile.com") };

const tiktokLink = {
  TIKTOKSHOP_SERVICE_ID: z.string().min(1).optional(),
  TIKTOKSHOP_AUTHORIZE_URL: z.url().default("https://services.tiktokshop.com/open/authorize"),
};
const tiktokSecret = {
  TIKTOKSHOP_APP_KEY: z.string().min(1).optional(),
  TIKTOKSHOP_APP_SECRET: z.string().min(8).optional(),
};
const tiktokApi = {
  TIKTOKSHOP_API_BASE_URL: z.url().default("https://open-api.tiktokglobalshop.com"),
  TIKTOKSHOP_AUTH_BASE_URL: z.url().default("https://auth.tiktok-shops.com"),
};

/**
 * Copying listings between stores (FR-PRD-13, backend doc 8.25). Shopee asks for at least 5 seconds
 * between creating an item and its variations (`SHOPEE_VARIANT_DELAY_MS`, tests use 0). Product images
 * are downloaded only from the marketplaces' image hosts; `PRODUCT_IMAGE_HOSTS` adds hosts (comma
 * separated), and plain http is accepted only in local and test.
 */
const listingCopy = {
  SHOPEE_VARIANT_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
  PRODUCT_IMAGE_HOSTS: z.string().default(""),
};

/**
 * Envelope encryption of marketplace tokens (technology doc 19.3). `aws_kms` wraps each tenant DEK
 * with KMS_KEY_ID_TOKENS; `local` wraps it with a 32-byte master key and is refused outside local/test.
 */
const tokenKeys = {
  TOKEN_KEY_PROVIDER: z.enum(["aws_kms", "local"]).default("aws_kms"),
  TOKEN_LOCAL_MASTER_KEY: z.string().optional(),
  KMS_KEY_ID_TOKENS: z.string().optional(),
  AWS_REGION: z.string().optional(),
};

/**
 * Private files (technology doc 13, ADR-009): shipping labels and printable documents in Cloudflare R2,
 * MinIO locally (same S3 API, `R2_ENDPOINT=http://127.0.0.1:9000`). Downloads go through short-lived
 * signed links. `local` keeps files in a directory served by the api and is refused outside local/test.
 */
const fileStorage = {
  FILE_STORAGE: z.enum(["r2", "local"]).default("r2"),
  FILE_STORAGE_LOCAL_DIR: z.string().min(1).default(".local/files"),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  /** S3 endpoint; defaults to https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com */
  R2_ENDPOINT: z.url().optional(),
  R2_BUCKET_DOCUMENTS: z.string().min(3).default("omniseller-documents"),
};

/**
 * Verification in two steps (technology doc 5.3, backend doc 8.30), api only: each user's TOTP secret is
 * sealed with TOTP_ENCRYPTION_KEY, and backup codes are HMACs under a key derived from it. Login runs in
 * the api, which never holds KMS (ADR-029), so this is not a tenant DEK. TOTP_ISSUER is the name
 * authenticator apps show next to the account.
 */
const twoFactor = {
  TOTP_ENCRYPTION_KEY: z
    .string({ error: "required: 32 random bytes, base64 (openssl rand -base64 32)" })
    .refine((v) => base64Key32(v), "must be 32 random bytes, base64 (openssl rand -base64 32)"),
  TOTP_ISSUER: z.string().min(1).max(40).default("OmniSeller"),
};

type Refinable = { NODE_ENV: string } & Record<string, unknown>;

const fileStorageRules = [
  {
    check: (e: Refinable) => e.FILE_STORAGE !== "local" || e.NODE_ENV === "local" || e.NODE_ENV === "test",
    path: "FILE_STORAGE",
    message: "local is only allowed when NODE_ENV is local or test; use r2",
  },
  {
    check: (e: Refinable) =>
      e.FILE_STORAGE !== "r2" ||
      (!!e.R2_ACCESS_KEY_ID && !!e.R2_SECRET_ACCESS_KEY && (!!e.R2_ACCOUNT_ID || !!e.R2_ENDPOINT)),
    path: "R2_ACCESS_KEY_ID",
    message:
      "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_ACCOUNT_ID (or R2_ENDPOINT) are required with FILE_STORAGE=r2",
  },
] as const;

function bothOrNeither(e: Record<string, unknown>, a: string, b: string): boolean {
  return (e[a] === undefined) === (e[b] === undefined);
}

function base64Key32(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return Buffer.from(value, "base64").length === 32;
}

const apiEnv = base
  .extend({
    APP_ROLE: z.literal("api"),
    PORT: z.coerce.number().int().positive().default(3000),
    ...apiRoleDb,
    ...publicWebUrl,
    ...shopeeLink,
    ...tiktokLink,
    ...fileStorage,
    ...twoFactor,
  })
  .refine(fileStorageRules[0].check, { path: [fileStorageRules[0].path], message: fileStorageRules[0].message })
  .refine(fileStorageRules[1].check, { path: [fileStorageRules[1].path], message: fileStorageRules[1].message });

const webhookEnv = base
  .extend({
    APP_ROLE: z.literal("webhook"),
    PORT: z.coerce.number().int().positive().default(3001),
    ...apiRoleDb,
    ...publicWebhookUrl,
    SHOPEE_PARTNER_ID: shopeeLink.SHOPEE_PARTNER_ID,
    ...shopeeSecret,
    ...tiktokSecret,
  })
  .refine((e) => bothOrNeither(e, "SHOPEE_PARTNER_ID", "SHOPEE_PARTNER_KEY"), {
    path: ["SHOPEE_PARTNER_KEY"],
    message: "SHOPEE_PARTNER_ID and SHOPEE_PARTNER_KEY are set together",
  })
  .refine((e) => bothOrNeither(e, "TIKTOKSHOP_APP_KEY", "TIKTOKSHOP_APP_SECRET"), {
    path: ["TIKTOKSHOP_APP_SECRET"],
    message: "TIKTOKSHOP_APP_KEY and TIKTOKSHOP_APP_SECRET are set together",
  });

/**
 * Email (technology doc 13): SMTP everywhere real mail is sent (Mailpit locally, the Amazon SES SMTP
 * interface in staging and production). `log` prints messages including their links and is refused
 * outside local; `memory` keeps them for tests.
 */
const emailEnv = {
  EMAIL_TRANSPORT: z.enum(["smtp", "log", "memory"]).default("smtp"),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().min(3).default("OmniSeller <noreply@omniseller.id>"),
};

const workerEnv = base
  .extend({
    APP_ROLE: z.literal("worker"),
    ...workerRoleDb,
    ...publicWebUrl,
    ...publicWebhookUrl,
    ...emailEnv,
    ...shopeeLink,
    ...shopeeSecret,
    ...shopeeApi,
    ...tiktokLink,
    ...tiktokSecret,
    ...tiktokApi,
    ...listingCopy,
    ...tokenKeys,
    ...fileStorage,
  })
  .refine((e) => bothOrNeither(e, "SHOPEE_PARTNER_ID", "SHOPEE_PARTNER_KEY"), {
    path: ["SHOPEE_PARTNER_KEY"],
    message: "SHOPEE_PARTNER_ID and SHOPEE_PARTNER_KEY are set together",
  })
  .refine((e) => bothOrNeither(e, "TIKTOKSHOP_APP_KEY", "TIKTOKSHOP_APP_SECRET"), {
    path: ["TIKTOKSHOP_APP_SECRET"],
    message: "TIKTOKSHOP_APP_KEY and TIKTOKSHOP_APP_SECRET are set together",
  })
  .refine((e: Refinable) => e.TOKEN_KEY_PROVIDER !== "local" || e.NODE_ENV === "local" || e.NODE_ENV === "test", {
    path: ["TOKEN_KEY_PROVIDER"],
    message: "local is only allowed when NODE_ENV is local or test; use aws_kms",
  })
  .refine((e) => e.TOKEN_KEY_PROVIDER !== "local" || base64Key32(e.TOKEN_LOCAL_MASTER_KEY), {
    path: ["TOKEN_LOCAL_MASTER_KEY"],
    message: "required with TOKEN_KEY_PROVIDER=local: 32 random bytes, base64 (openssl rand -base64 32)",
  })
  .refine((e) => e.TOKEN_KEY_PROVIDER !== "aws_kms" || (!!e.KMS_KEY_ID_TOKENS && !!e.AWS_REGION), {
    path: ["KMS_KEY_ID_TOKENS"],
    message: "KMS_KEY_ID_TOKENS and AWS_REGION are required with TOKEN_KEY_PROVIDER=aws_kms",
  })
  .refine((e) => e.EMAIL_TRANSPORT !== "smtp" || !!e.SMTP_URL, {
    path: ["SMTP_URL"],
    message: "required when EMAIL_TRANSPORT=smtp",
  })
  .refine((e) => e.EMAIL_TRANSPORT !== "log" || e.NODE_ENV === "local", {
    path: ["EMAIL_TRANSPORT"],
    message: "log is only allowed when NODE_ENV=local (it prints secret links)",
  })
  .refine((e) => e.EMAIL_TRANSPORT !== "memory" || e.NODE_ENV === "test", {
    path: ["EMAIL_TRANSPORT"],
    message: "memory is only allowed when NODE_ENV=test",
  })
  .refine(fileStorageRules[0].check, { path: [fileStorageRules[0].path], message: fileStorageRules[0].message })
  .refine(fileStorageRules[1].check, { path: [fileStorageRules[1].path], message: fileStorageRules[1].message });

const schedulerEnv = base.extend({
  APP_ROLE: z.literal("scheduler"),
  ...workerRoleDb,
  ...systemRoleDb,
});

const researchCollectorEnv = base.extend({
  APP_ROLE: z.literal("research-collector"),
  ...workerRoleDb,
});

export const envSchema = z.discriminatedUnion("APP_ROLE", [
  apiEnv,
  webhookEnv,
  workerEnv,
  schedulerEnv,
  researchCollectorEnv,
]);

export type Env = z.infer<typeof envSchema>;
export type EnvFor<R extends AppRole> = Extract<Env, { APP_ROLE: R }>;

export class InvalidEnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment:\n  ${issues.join("\n  ")}`);
    this.name = "InvalidEnvError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const role = source.APP_ROLE;
  if (!role || !(APP_ROLES as readonly string[]).includes(role)) {
    throw new InvalidEnvError([`APP_ROLE must be one of ${APP_ROLES.join(", ")} (got ${role ?? "nothing"})`]);
  }
  // An empty value in an env file means "not set" (optional marketplace keys, KMS outside AWS).
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const result = envSchema.safeParse(present);
  if (!result.success) {
    throw new InvalidEnvError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return result.data;
}
