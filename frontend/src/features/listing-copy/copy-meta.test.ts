import { describe, expect, it } from "vitest";
import {
  attributeValues,
  copyProgress,
  draftPatch,
  editProblems,
  editState,
  priceRange,
  problemsAt,
  publishable,
  requiredNow,
  sortedAttributes,
  working,
} from "./copy-meta";
import { categoryFixture, draftFixture } from "./fixtures";

const rupiah = (n: number) => `Rp ${n}`;

describe("copies and drafts", () => {
  it("counts every item the worker is done with, drafted, skipped, or failed", () => {
    expect(copyProgress({ itemsTotal: 20, itemsDrafted: 6, itemsSkipped: 2, itemsFailed: 2 })).toBe(50);
    expect(copyProgress({ itemsTotal: 0, itemsDrafted: 0, itemsSkipped: 0, itemsFailed: 0 })).toBe(0);
  });

  it("publishes drafts and failed drafts without blocking problems only", () => {
    expect(publishable({ status: "draft", blockingProblems: 0 })).toBe(true);
    expect(publishable({ status: "failed", blockingProblems: 0 })).toBe(true);
    expect(publishable({ status: "draft", blockingProblems: 1 })).toBe(false);
    expect(publishable({ status: "published", blockingProblems: 0 })).toBe(false);
    expect(working({ status: "preparing" })).toBe(true);
    expect(working({ status: "publishing" })).toBe(true);
    expect(working({ status: "draft" })).toBe(false);
  });

  it("writes a price or a range", () => {
    expect(priceRange(55_000, 55_000, rupiah)).toBe("Rp 55000");
    expect(priceRange(55_000, 57_000, rupiah)).toBe("Rp 55000 – Rp 57000");
    expect(priceRange(null, null, rupiah)).toBe("—");
  });

  it("finds the problems of a part and of what is inside it", () => {
    const problems = draftFixture().problems;
    expect(problemsAt(problems, "attributes.102254").map((p) => p.code)).toEqual(["attribute.required"]);
    expect(problemsAt(problems, "variants").map((p) => p.code)).toEqual(["variant.unmapped"]);
    expect(problemsAt(problems, "attributes.10225")).toEqual([]);
  });
});

describe("the draft editor", () => {
  it("sends nothing when nothing changed", () => {
    const s = editState(draftFixture());
    expect(draftPatch(s, structuredClone(s))).toEqual({});
  });

  it("sends only what changed, so an untouched description keeps its formatting", () => {
    const before = editState(draftFixture());
    const after = { ...before, title: "Kaos Polos Premium Katun Combed 30s ", brand: " " };
    expect(draftPatch(before, after)).toEqual({ title: "Kaos Polos Premium Katun Combed 30s", brand: null });
  });

  it("sends all attributes when one changes, chosen ids and typed text with its unit", () => {
    const before = editState(draftFixture());
    const after = {
      ...before,
      attributes: {
        ...before.attributes,
        "102254": { valueIds: ["1000059"], text: "", unit: "" },
        "100200": { valueIds: [], text: "180", unit: "g" },
        "100300": { valueIds: [], text: "", unit: "" },
      },
    };
    expect(draftPatch(before, after).attributes).toEqual([
      { attributeId: "100134", values: [{ valueId: "1234" }] },
      { attributeId: "100200", values: [{ name: "180", unit: "g" }] },
      { attributeId: "102254", values: [{ valueId: "1000059" }] },
    ]);
    // opened and left empty: no change at all
    expect(
      draftPatch(before, {
        ...before,
        attributes: { ...before.attributes, "100300": { valueIds: [], text: "", unit: "" } },
      }),
    ).toEqual({});
    expect(attributeValues({ valueIds: ["1"], text: "Wol, Linen", unit: "" })).toEqual([
      { valueId: "1" },
      { name: "Wol" },
      { name: "Linen" },
    ]);
  });

  it("sends the photos in their new order, the package, and the variants that stay", () => {
    const before = editState(draftFixture());
    const after = {
      ...before,
      images: [...before.images].reverse(),
      weightG: "300",
      length: "",
      width: "",
      height: "",
      preOrderDays: "",
      variants: [{ ...before.variants[1]!, sku: "KAOS-HTM-L", price: "65000" }],
    };
    expect(draftPatch(before, after)).toEqual({
      images: ["https://cf.shopee.co.id/file/kaos-2", "https://cf.shopee.co.id/file/kaos-1"],
      weightG: 300,
      dimensionsMm: null,
      variants: [{ key: "9102", sku: "KAOS-HTM-L", price: 65_000, options: ["Hitam", "L"] }],
    });
  });

  it("checks the title, whole numbers, and all three package sides", () => {
    const s = editState(draftFixture());
    expect(editProblems(s)).toEqual({});
    // no package size at all is fine; a part of one is not
    expect(editProblems({ ...s, length: "", width: "", height: "" })).toEqual({});
    expect(
      editProblems({ ...s, title: " ", weightG: "0,5", length: "300", width: "", height: "30", preOrderDays: "x" }),
    ).toEqual({ title: "required", weight: "whole", dimensions: "dimensions", preOrderDays: "whole" });
    expect(editProblems({ ...s, variants: [{ ...s.variants[0]!, price: "60.500" }] })).toEqual({
      "variants.9101.price": "whole",
    });
  });

  it("puts required attributes first, and requires some only when another value is chosen", () => {
    const rules = categoryFixture().rules!;
    expect(sortedAttributes(rules).map((a) => a.name)).toEqual(["Barang Impor", "Bahan", "Berat Kain"]);
    const fabric = rules.attributes[2]!;
    expect(requiredNow(fabric, {})).toBe(false);
    expect(requiredNow(fabric, { "102254": { valueIds: ["1000059"], text: "", unit: "" } })).toBe(true);
    expect(requiredNow(fabric, { "102254": { valueIds: ["1000060"], text: "", unit: "" } })).toBe(false);
  });
});
