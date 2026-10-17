import { type HttpCallTarget, requestJson } from "@omniseller/connector-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceLimiter } from "../../src/common/security/marketplace-limiter";
import { RateLimiter } from "../../src/common/security/rate-limiter";
import { connectorRateFeedback, connectorRequestGate, withRequestGate } from "../../src/modules/sync/connector-calls";
import { testHandles } from "../setup/handles";

const time = vi.hoisted(() => ({ now: 1_800_000_000_000, waits: [] as number[] }));
vi.mock("node:timers/promises", () => ({
  setTimeout: async (milliseconds: number) => {
    time.now += milliseconds;
    time.waits.push(milliseconds);
  },
}));
const h = testHandles();
let sequence = 0;
let prefix: string;
let limiter: RateLimiter;
const rule = { capacity: 10_000, refillPerSecond: 10_000 };
const target: HttpCallTarget = {
  method: "GET",
  path: "/affiliate_seller/202608/marketplace_creators/creator_opaque_A",
  applicationId: "PUBLIC_APP_A",
  principalScoped: true,
};
const gate = (principal = "A", channel = "tiktokshop") => ({
  limiter,
  key: `mp:${channel}:tenant:principal:${principal}`,
  rule,
  channel,
});
const run = <T>(principal: string, action: () => Promise<T>) => withRequestGate(gate(principal), action);
const throttle = (principal: string, input = target, retryAfterMs = 120_000, code?: string) =>
  run(principal, () =>
    connectorRateFeedback({
      ...input,
      complete: true,
      httpStatus: code ? 200 : 429,
      ...(code ? { businessCode: code } : {}),
      retryAfterMs,
    }),
  );
const dispatch = (principal: string, input = target) => run(principal, () => connectorRequestGate(input));
const keys = () => h.redis.keys(`${prefix}:marketplace:*`);

beforeEach(() => {
  prefix = `${h.infra.keyPrefix}:adaptive-review:${++sequence}`;
  limiter = new RateLimiter(h.redis, prefix);
  time.now = 1_800_000_000_000;
  time.waits = [];
  vi.spyOn(Date, "now").mockImplementation(() => time.now);
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(async () => {
  vi.restoreAllMocks();
  const ownKeys = await h.redis.keys(`${prefix}:*`);
  if (ownKeys.length) await h.redis.del(...ownKeys);
});

describe("marketplace adaptive pacing with real Redis Lua", () => {
  it("isolates cooldown by app, principal, endpoint and method, retaining a provider Retry-After above 60 seconds", async () => {
    await throttle("A");
    await expect(dispatch("A")).rejects.toMatchObject({ code: "local_rate_limit", retryAfterMs: 120_000 });
    expect(time.waits).toEqual([]);
    await dispatch("B");
    await dispatch("A", { ...target, applicationId: "PUBLIC_APP_B" });
    await dispatch("A", { ...target, method: "POST" });
    await dispatch("A", { ...target, path: "/affiliate_creator/202508/profiles" });
    expect(await keys()).toHaveLength(5);
  });

  it("shares a cooldown between opaque or numeric resources of the same reviewed endpoint", async () => {
    await throttle("A");
    await expect(
      dispatch("A", { ...target, path: "/affiliate_seller/202608/marketplace_creators/creator_opaque_B" }),
    ).rejects.toMatchObject({ code: "local_rate_limit" });
    await expect(
      dispatch("A", { ...target, path: "/affiliate_seller/202608/marketplace_creators/9223372036854775807" }),
    ).rejects.toMatchObject({ code: "local_rate_limit" });
    expect(await keys()).toHaveLength(1);
  });

  it("shares application authorization cooldown across principals without blocking another application", async () => {
    const auth = { ...target, path: "/authorization/202309/shops", principalScoped: false };
    await throttle("A", auth);
    await expect(dispatch("B", auth)).rejects.toMatchObject({ code: "local_rate_limit", retryAfterMs: 120_000 });
    await dispatch("B", { ...auth, applicationId: "PUBLIC_APP_B" });
    expect(await keys()).toHaveLength(2);
  });

  it("treats TikTok 36009002 as throttle, but keeps 503 server failures out of adaptive penalty state", async () => {
    await throttle("A", target, 120_000, "36009002");
    await expect(dispatch("A")).rejects.toMatchObject({ code: "local_rate_limit" });
    await run("B", () =>
      connectorRateFeedback({ ...target, complete: true, httpStatus: 503, businessCode: "36009003" }),
    );
    expect(await keys()).toHaveLength(1);
    await dispatch("B");
    const state = await h.redis.hgetall((await keys()).find((key) => key.includes("principal:B"))!);
    expect(Number(state.scale)).toBe(1);
    expect(state.blocked).toBeUndefined();
  });

  it("backs off 1, 2, 4, 8, 16, 32 then 60 seconds, with a ten-percent floor and ten-minute incremental recovery", async () => {
    const adaptive = new MarketplaceLimiter(h.redis, `${prefix}:direct`);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      await adaptive.feedback("endpoint", true, 0, time.now, 0);
      expect(await adaptive.take("endpoint", { capacity: 10, refillPerSecond: 10 }, time.now)).toMatchObject({
        allowed: false,
        retryAfterMs: delay,
      });
      time.now += delay;
    }
    const last = time.now - 60_000;
    expect(Number(await h.redis.hget(`${prefix}:direct:endpoint`, "scale"))).toBe(0.1);
    await adaptive.feedback("endpoint", false, 0, last + 599_999, 0);
    expect(Number(await h.redis.hget(`${prefix}:direct:endpoint`, "scale"))).toBe(0.1);
    await adaptive.feedback("endpoint", false, 0, last + 600_000, 0);
    expect(Number(await h.redis.hget(`${prefix}:direct:endpoint`, "scale"))).toBeCloseTo(0.12);
    await adaptive.feedback("endpoint", false, 0, last + 600_001, 0);
    expect(Number(await h.redis.hget(`${prefix}:direct:endpoint`, "scale"))).toBeCloseTo(0.12);
    await adaptive.feedback("endpoint", false, 0, last + 1_200_000, 0);
    expect(Number(await h.redis.hget(`${prefix}:direct:endpoint`, "scale"))).toBeCloseTo(0.144);
  });

  it("shares dispatch tokens atomically across limiter instances", async () => {
    const left = new MarketplaceLimiter(h.redis, `${prefix}:direct`);
    const right = new MarketplaceLimiter(h.redis, `${prefix}:direct`);
    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? left : right).take("endpoint", { capacity: 3, refillPerSecond: 1 }, time.now),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.allowed).every((decision) => decision.retryAfterMs === 1000)).toBe(
      true,
    );
  });

  it("does not send a queued write again after 429, and stores neither body, token, application ID nor opaque resource in Redis", async () => {
    let sent = 0;
    const url = new URL(
      "https://open-api.tiktokglobalshop.com/affiliate_creator/202405/showcases/products/add?app_key=PUBLIC_APP_A",
    );
    const http = {
      beforeRequest: connectorRequestGate,
      afterResponse: connectorRateFeedback,
      fetch: (async () => {
        sent++;
        return Response.json(
          { code: 36009002, message: "PRIVATE_BUYER_TEXT" },
          { status: 429, headers: { "retry-after": "121" } },
        );
      }) as typeof fetch,
    };
    const request = () =>
      run("A", () =>
        requestJson(
          http,
          {
            method: "POST",
            url,
            headers: { "x-tts-access-token": "PRIVATE_ACCESS_TOKEN" },
            body: '{"note":"PRIVATE_BUYER_TEXT"}',
          },
          () => undefined,
        ),
      );
    expect((await request()).status).toBe(429);
    await expect(request()).rejects.toMatchObject({ code: "local_rate_limit", retryAfterMs: 121_000 });
    expect(sent).toBe(1);
    await throttle("A");
    const serialized = JSON.stringify(
      await Promise.all((await keys()).map(async (key) => [key, await h.redis.hgetall(key)])),
    );
    for (const privateValue of ["PRIVATE_BUYER_TEXT", "PRIVATE_ACCESS_TOKEN", "PUBLIC_APP_A", "creator_opaque_A"])
      expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain("body");
  });

  it("preserves an HTTP outcome when async feedback rejects, and waits for successful feedback without repeating the request", async () => {
    const calls: string[] = [];
    const response = await requestJson(
      {
        fetch: (async () => {
          calls.push("sent");
          return Response.json({ code: 0, data: { result: "accepted" } });
        }) as typeof fetch,
        beforeRequest: async () => {
          calls.push("gate");
        },
        afterResponse: async () => {
          await Promise.resolve();
          calls.push("feedback");
          throw new Error("Redis disconnected");
        },
      },
      { method: "POST", url: new URL("https://open-api.tiktokglobalshop.com/product/202309/products") },
      () => undefined,
    );
    expect(response.json).toMatchObject({ code: 0, data: { result: "accepted" } });
    expect(calls).toEqual(["gate", "sent", "feedback"]);
  });
  it("bounds unavailable feedback to one second without changing an acknowledged write", async () => {
    const start = performance.now();
    const result = await requestJson(
      {
        fetch: (async () => Response.json({ code: 0, data: { accepted: true } })) as typeof fetch,
        afterResponse: async () => new Promise<void>(() => {}),
      },
      { method: "POST", url: new URL("https://open-api.tiktokglobalshop.com/product/202309/products") },
      () => undefined,
    );
    expect(result.json).toMatchObject({ code: 0, data: { accepted: true } });
    expect(performance.now() - start).toBeLessThan(1800);
  });
});
