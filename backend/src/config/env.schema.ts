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

const apiEnv = base.extend({
  APP_ROLE: z.literal("api"),
  PORT: z.coerce.number().int().positive().default(3000),
  ...apiRoleDb,
  ...publicWebUrl,
});

const webhookEnv = base.extend({
  APP_ROLE: z.literal("webhook"),
  PORT: z.coerce.number().int().positive().default(3001),
  ...apiRoleDb,
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
    ...emailEnv,
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
  });

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
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new InvalidEnvError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return result.data;
}
