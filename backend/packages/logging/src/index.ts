import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

/**
 * Keys that must never reach a log line (backend doc 14.1, invariant I8).
 * Matched at any depth up to four levels; pino redaction does not support recursive wildcards.
 */
const SENSITIVE_KEYS = [
  "buyer_name",
  "buyer_phone",
  "buyerName",
  "buyerPhone",
  "shipping_address",
  "shippingAddress",
  "email",
  "password",
  "token",
  "authorization",
  "cookie",
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
];

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of SENSITIVE_KEYS) {
    paths.push(key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`);
  }
  return paths;
}

const SUFFIX_PATTERN = /(_enc|_hash|Enc|Hash)$/;

/** Removes `*_enc` and `*_hash` keys, which pino path redaction cannot express. */
function stripSuffixed(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripSuffixed(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SUFFIX_PATTERN.test(k) ? "[Redacted]" : stripSuffixed(v, depth + 1);
  }
  return out;
}

/** Fields added to every line: request_id, trace_id, tenant_id, actor. Set by the app at startup. */
export type LogContextProvider = () => Record<string, unknown> | undefined;

let contextProvider: LogContextProvider = () => undefined;

export function setLogContextProvider(provider: LogContextProvider): void {
  contextProvider = provider;
}

export interface CreateLoggerOptions {
  level?: string;
  pretty?: boolean;
  destination?: DestinationStream;
  base?: Record<string, unknown>;
}

export function createRootLogger(options: CreateLoggerOptions = {}): Logger {
  const config: LoggerOptions = {
    level: options.level ?? "info",
    base: options.base ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "msg",
    redact: { paths: redactPaths(), censor: "[Redacted]" },
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => stripSuffixed(obj) as Record<string, unknown>,
    },
    mixin: () => contextProvider() ?? {},
  };
  if (options.pretty && !options.destination) {
    config.transport = { target: "pino-pretty", options: { colorize: true, singleLine: true } };
  }
  return options.destination ? pino(config, options.destination) : pino(config);
}

let root: Logger = createRootLogger({ level: process.env.LOG_LEVEL ?? "info" });
let children = new Map<string, Logger>();

/** Replaces the process-wide root logger. Called once by the app bootstrap after config is validated. */
export function configureLogger(options: CreateLoggerOptions): Logger {
  root = createRootLogger(options);
  children = new Map();
  return root;
}

function childFor(module: string): Logger {
  let child = children.get(module);
  if (!child) {
    child = root.child({ module });
    children.set(module, child);
  }
  return child;
}

export const logger = {
  get root(): Logger {
    return root;
  },
  /**
   * Module loggers are usually created at import time, before the bootstrap configures the root.
   * The returned logger resolves the current root on every call, so it always carries the final
   * level, base fields (role), and destination.
   */
  forModule(module: string): Logger {
    return new Proxy({} as Logger, {
      get(_target, prop) {
        const child = childFor(module);
        const value = Reflect.get(child, prop, child);
        return typeof value === "function" ? value.bind(child) : value;
      },
    });
  },
};

export type { Logger };
