import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CallRecord,
  type ConnectorError,
  type HttpCallTarget,
  type HttpRateFeedback,
  isConnectorError,
  type RateLimitRule,
  TransientConnectorError,
} from "@omniseller/connector-core";
import { TIKTOK_COMMERCE_OPERATIONS } from "@omniseller/connector-tiktokshop";
import type { RateLimiter } from "../../common/security/rate-limiter";

/**
 * Connector call recording (backend doc 8.6): every HTTP call a connector makes inside
 * `recordConnectorCalls` is appended, already redacted by the connector, to the given list, which the
 * sync log stores with the operation. Connectors are built with `connectorCallObserver`.
 */
const callScope = new AsyncLocalStorage<CallRecord[]>();

export function recordConnectorCalls<T>(into: CallRecord[], fn: () => Promise<T>): Promise<T> {
  return callScope.run(into, fn);
}

export const connectorCallObserver = (record: CallRecord): void => {
  callScope.getStore()?.push(record);
};

/**
 * Per-shop rate limit applied to every HTTP call a connector makes (technology doc 7.1, token bucket
 * per store): one operation may make hundreds of calls (a catalog pull), so the bucket is taken per
 * request, not per operation. Inside `withRequestGate`, each request waits for a token up to
 * `MAX_WAIT_MS` in total, then gives up with a transient error so BullMQ retries later.
 *
 * Background reads (parcel tracking, backend doc 8.22) also take from a smaller bucket of their own,
 * `BACKGROUND_SHARE` of the store's rate, so they never use up what stock pushes and order work need.
 * They may wait longer (`BACKGROUND_MAX_WAIT_MS`), on a queue of their own.
 */
interface Gate {
  limiter: RateLimiter;
  key: string;
  rule: RateLimitRule;
  channel?: string;
  background?: boolean;
  waitedMs: number;
}

const gateScope = new AsyncLocalStorage<Gate>();
const MAX_WAIT_MS = 30_000;
export const BACKGROUND_SHARE = 0.3;
const BACKGROUND_MAX_WAIT_MS = 120_000;

export function withRequestGate<T>(gate: Omit<Gate, "waitedMs">, fn: () => Promise<T>): Promise<T> {
  return gateScope.run({ ...gate, waitedMs: 0 }, fn);
}

/** The bucket of a store's background reads: `BACKGROUND_SHARE` of its rate, at least one call a second. */
export function backgroundRule(rule: RateLimitRule): RateLimitRule {
  return {
    capacity: Math.max(1, Math.floor(rule.capacity * BACKGROUND_SHARE)),
    refillPerSecond: Math.max(1, Math.floor(rule.refillPerSecond * BACKGROUND_SHARE)),
  };
}

const endpointContracts = TIKTOK_COMMERCE_OPERATIONS.filter((operation) => operation.path.includes("{"))
  .map((operation) => ({
    method: operation.method,
    path: operation.path,
    pattern: new RegExp(
      `^${operation.path
        .split(/(\{[^}]+\})/g)
        .map((part) => (/^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("")}$`,
    ),
    specificity: operation.path.replace(/\{[^}]+\}/g, "").length,
  }))
  .sort((left, right) => right.specificity - left.specificity);

function adaptiveKey(gate: Gate, target: HttpCallTarget): string {
  // Opaque marketplace IDs are not reliably distinguishable from static path segments by length.
  // Prefer the reviewed method/path template so all resources share their actual endpoint budget.
  const endpoint =
    endpointContracts.find((contract) => contract.method === target.method && contract.pattern.test(target.path))
      ?.path ?? target.path.replace(/\/(?:\d{7,}|[a-f\d]{24,}|[0-9A-HJKMNP-TV-Z]{26})(?=\/|$)/gi, "/{id}");
  const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
  const app = hash(target.applicationId ?? "configured-app");
  const appLevel = /(?:^|\/)(?:auth|authorization|token)(?:\/|$)/.test(target.path);
  return `${appLevel ? `app:${gate.channel ?? gate.key.split(":")[1]}` : gate.key}:${app}:${hash(`${target.method} ${endpoint}`)}`;
}
export async function connectorRateFeedback(feedback: HttpRateFeedback): Promise<void> {
  const gate = gateScope.getStore();
  if (!gate?.limiter.marketplace) return;
  const throttled = feedback.httpStatus === 429 || feedback.businessCode === "36009002";
  const success =
    feedback.complete &&
    feedback.httpStatus !== null &&
    feedback.httpStatus >= 200 &&
    feedback.httpStatus < 300 &&
    (!feedback.businessCode || feedback.businessCode === "0");
  if (throttled || success)
    await gate.limiter.marketplace.feedback(adaptiveKey(gate, feedback), throttled, feedback.retryAfterMs);
}
export async function connectorRequestGate(target?: HttpCallTarget): Promise<void> {
  const gate = gateScope.getStore();
  if (!gate) return;
  if (gate.background) await takeToken(gate, `${gate.key}:background`, backgroundRule(gate.rule));
  await takeToken(gate, gate.key, gate.rule);
  if (target && gate.limiter.marketplace) {
    const heavy = /analytics|data_compass|performance/.test(target.path);
    const rate = heavy
      ? 1
      : target.method === "GET"
        ? Math.min(10, gate.rule.refillPerSecond)
        : Math.min(3, gate.rule.refillPerSecond);
    for (;;) {
      const decision = await gate.limiter.marketplace.take(adaptiveKey(gate, target), {
        capacity: Math.max(1, Math.min(rate, gate.rule.capacity)),
        refillPerSecond: rate,
      });
      if (decision.allowed) break;
      const wait = Math.max(50, decision.retryAfterMs);
      if (gate.waitedMs + wait > (gate.background ? BACKGROUND_MAX_WAIT_MS : MAX_WAIT_MS))
        throw new TransientConnectorError({
          code: "local_rate_limit",
          message: "Marketplace endpoint is cooling down",
          retryAfterMs: wait,
        });
      gate.waitedMs += wait;
      await sleep(wait);
    }
  }
}

async function takeToken(gate: Gate, key: string, rule: RateLimitRule): Promise<void> {
  const maxWait = gate.background ? BACKGROUND_MAX_WAIT_MS : MAX_WAIT_MS;
  for (;;) {
    const decision = await gate.limiter.take(key, {
      capacity: rule.capacity,
      refill: rule.refillPerSecond,
      windowMs: 1000,
    });
    if (decision.allowed) return;
    const wait = Math.max(50, decision.retryAfterSeconds * 1000);
    if (gate.waitedMs + wait > maxWait) {
      throw new TransientConnectorError({
        code: "local_rate_limit",
        message: "per-store call budget used up",
        retryAfterMs: wait,
      });
    }
    gate.waitedMs += wait;
    await sleep(wait);
  }
}

const KIND_MESSAGES: Record<ConnectorError["kind"], string> = {
  transient: "Marketplace sedang sibuk atau tidak bisa dihubungi. OmniSeller mencoba lagi otomatis.",
  auth_expired: "Token akses toko kedaluwarsa dan sedang diperbarui otomatis.",
  auth_revoked: "Izin toko dicabut atau sudah habis. Hubungkan ulang toko ini.",
  permanent: "Marketplace menolak permintaan ini.",
};

/**
 * Error code and a message a seller can act on (FR-INT-06: "pesan error yang mudah dipahami"). The
 * marketplace's own message is kept after the explanation for support.
 */
export function describeSyncError(err: unknown): { code: string; message: string } {
  if (isConnectorError(err)) {
    if (err.code === "missing_scope")
      return {
        code: `${err.kind}.${err.code}`,
        message:
          "Izin API akun belum mencakup fitur ini. Aktifkan izin terkait di marketplace lalu hubungkan ulang akun.",
      };
    if (err.code === "scope_contract_unverified")
      return {
        code: `${err.kind}.${err.code}`,
        message: "Fitur belum tersedia karena persyaratan izin API belum terverifikasi untuk jenis akun ini.",
      };
    const detail = err.message.replace(/^[^:]+:\s*/, "");
    return {
      code: `${err.kind}.${err.code}`.slice(0, 120),
      message: `${KIND_MESSAGES[err.kind]} (${detail})`.slice(0, 1000),
    };
  }
  const code = (err as { code?: unknown })?.code;
  return {
    code: typeof code === "string" ? code.slice(0, 120) : "internal",
    message: "Terjadi kesalahan di OmniSeller. Tim kami sudah menerima laporannya.",
  };
}
