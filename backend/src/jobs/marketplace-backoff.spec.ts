import { describe, expect, it } from "vitest";
import { marketplaceBackoff } from "./marketplace-backoff";

describe("marketplace backoff", () => {
  it("honours a rate-limit or lease hint instead of consuming retries before the deadline", () => {
    const error = Object.assign(new Error("lease busy"), { retryAfterMs: 290_000 });
    expect(marketplaceBackoff(1, "marketplace", error)).toBe(290_000);
    expect(marketplaceBackoff(3, "marketplace", new Error("network"))).toBe(20_000);
  });
  it("rejects unknown strategies and ignores invalid delays", () => {
    expect(() => marketplaceBackoff(1, "unknown", new Error())).toThrow();
    expect(marketplaceBackoff(2, "marketplace", Object.assign(new Error(), { retryAfterMs: Number.NaN }))).toBe(10_000);
  });
});
