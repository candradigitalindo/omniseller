import { describe, expect, it } from "vitest";
import {
  bestSuggestion,
  costRange,
  historyValue,
  listingTotal,
  mappedPercent,
  parseAttributeNames,
  parseImageUrls,
  priceRange,
  range,
  type Suggestion,
  variantLabel,
} from "./product-meta";

const rp = (n: number) => `Rp ${n}`;
const suggestion = (over: Partial<Suggestion>): Suggestion => ({
  variantId: "v",
  sku: "SKU",
  variantName: "L",
  productId: "p",
  productName: "Kaos",
  score: 1,
  reason: "sku",
  ...over,
});

describe("catalog rules", () => {
  it("summarises prices over live variants, all of them when every one is archived", () => {
    expect(range([])).toBeNull();
    expect(
      priceRange([
        { basePrice: 65_000, status: "active" },
        { basePrice: 70_000, status: "active" },
        { basePrice: 10_000, status: "archived" },
      ]),
    ).toEqual({ min: 65_000, max: 70_000 });
    expect(priceRange([{ basePrice: 10_000, status: "archived" }])).toEqual({ min: 10_000, max: 10_000 });
  });

  it("shows cost only when the api gave it", () => {
    expect(costRange([{ costPrice: null }, { costPrice: null }])).toBeNull();
    expect(costRange([{ costPrice: 35_000 }, { costPrice: null }])).toEqual({ min: 35_000, max: 35_000 });
    expect(listingTotal([{ listingCount: 2 }, { listingCount: 1 }])).toBe(3);
  });

  it("names a variant by its name, else its attributes, else its SKU", () => {
    expect(variantLabel({ name: "Hitam, L", attributes: {}, sku: "X" })).toBe("Hitam, L");
    expect(variantLabel({ name: " ", attributes: { Warna: "Hitam", Ukuran: "L" }, sku: "X" })).toBe("Hitam, L");
    expect(variantLabel({ name: "", attributes: {}, sku: "KAOS-L" })).toBe("KAOS-L");
  });

  it("reads image addresses and attribute names as the api takes them", () => {
    expect(parseImageUrls("https://a.test/1.jpg\n\n http://b.test/2.jpg \nhttps://c.test/3.png")).toEqual({
      urls: ["https://a.test/1.jpg", "https://c.test/3.png"],
      invalid: ["http://b.test/2.jpg"],
    });
    expect(parseAttributeNames(" Warna, Ukuran,, Warna ")).toEqual(["Warna", "Ukuran"]);
  });

  it("prefers the same SKU, then the closest name, and drops weak name matches", () => {
    const sku = suggestion({ sku: "A", reason: "sku", score: 1 });
    const close = suggestion({ sku: "B", reason: "name", score: 0.9 });
    const weak = suggestion({ sku: "C", reason: "name", score: 0.3 });
    expect(bestSuggestion({ suggestions: [weak, close, sku] })?.sku).toBe("A");
    expect(bestSuggestion({ suggestions: [weak, close] })?.sku).toBe("B");
    expect(bestSuggestion({ suggestions: [weak] })).toBeNull();
  });

  it("counts the mapped share in whole percent, a store without listings as done", () => {
    expect(mappedPercent({ total: 430, mapped: 412 })).toBe(95);
    expect(mappedPercent({ total: 3, mapped: 2 })).toBe(66);
    expect(mappedPercent({ total: 0, mapped: 0 })).toBe(100);
  });

  it("writes history values for people", () => {
    expect(historyValue("basePrice", 65_000, rp)).toBe("Rp 65000");
    expect(historyValue("weightG", 200, rp)).toBe("200");
    expect(historyValue("imageUrls", ["a", "b"], rp)).toBe("a, b");
    expect(historyValue("attributes", { Warna: "Hitam" }, rp)).toBe("Warna: Hitam");
    expect(historyValue("barcode", null, rp)).toBe("—");
  });
});
