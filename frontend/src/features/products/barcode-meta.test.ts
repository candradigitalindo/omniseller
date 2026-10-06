import { describe, expect, it } from "vitest";
import { copiesOf, labelItems, labelProblems } from "./barcode-meta";

describe("barcode labels", () => {
  it("reads copies as whole numbers from 0 to 500, empty as none", () => {
    expect(copiesOf("")).toBe(0);
    expect(copiesOf(" 3 ")).toBe(3);
    expect(copiesOf("500")).toBe(500);
    expect(copiesOf("501")).toBeNull();
    expect(copiesOf("1.5")).toBeNull();
    expect(copiesOf("-1")).toBeNull();
  });

  it("sends only variants with labels, in the order shown", () => {
    expect(labelItems(["a", "b", "c", "d"], { a: "2", b: "0", c: "", d: "x" })).toEqual([
      { variantId: "a", copies: 2 },
    ]);
    expect(labelItems(["b", "a"], { a: "1", b: "4" })).toEqual([
      { variantId: "b", copies: 4 },
      { variantId: "a", copies: 1 },
    ]);
  });

  it("names unreadable counts and keeps a document within 2,000 labels", () => {
    expect(labelProblems(["a", "b"], { a: "x", b: "2" })).toEqual({ invalid: ["a"], total: 2, tooMany: false });
    expect(labelProblems(["a", "b", "c", "d"], { a: "500", b: "500", c: "500", d: "500" })).toEqual({
      invalid: [],
      total: 2_000,
      tooMany: false,
    });
    expect(labelProblems(["a", "b", "c", "d", "e"], { a: "500", b: "500", c: "500", d: "500", e: "1" })).toMatchObject({
      total: 2_001,
      tooMany: true,
    });
  });
});
