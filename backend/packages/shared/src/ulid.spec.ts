import { describe, expect, it } from "vitest";
import { isUlid, newId, newIdAt, ULID_REGEX, ulidLowerBound, ulidTime } from "./ulid.js";

describe("ulid", () => {
  it("generates valid, strictly increasing ids within the same millisecond", () => {
    const ids = Array.from({ length: 1000 }, () => newId());
    for (const id of ids) expect(id).toMatch(ULID_REGEX);
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("round-trips the timestamp", () => {
    const before = Date.now();
    const id = newId();
    const t = ulidTime(id).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it("builds partition lower bounds that sort before every id of that moment", () => {
    const at = new Date(Date.UTC(2026, 8, 1));
    const bound = ulidLowerBound(at);
    expect(bound).toMatch(ULID_REGEX);
    expect(bound.endsWith("0000000000000000")).toBe(true);
    expect(ulidTime(bound).getTime()).toBe(at.getTime());
    expect(newId() > bound).toBe(true);
    expect(ulidLowerBound(new Date(Date.UTC(2026, 9, 1))) > bound).toBe(true);
  });

  it("rejects lowercase and ambiguous letters", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isUlid("01arz3ndektsv4rrffq69g5fav")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAI")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(false);
  });

  it("builds ids at a given moment that sort by that moment", () => {
    const placed = new Date(Date.UTC(2026, 6, 15, 8, 30));
    const id = newIdAt(placed);
    expect(id).toMatch(ULID_REGEX);
    expect(ulidTime(id).getTime()).toBe(placed.getTime());
    expect(id < newIdAt(new Date(placed.getTime() + 1))).toBe(true);
    expect(id > ulidLowerBound(new Date(Date.UTC(2026, 6, 1)))).toBe(true);
  });
});
