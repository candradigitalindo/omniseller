import type { components } from "@/lib/api/schema";

export type ProductListItem = components["schemas"]["ProductPageDto_Output"]["items"][number];
export type Product = components["schemas"]["ProductDto_Output"];
export type Variant = Product["variants"][number];
export type HistoryEntry = components["schemas"]["ProductHistoryPageDto_Output"]["items"][number];
export type Listing = components["schemas"]["ListingPageDto_Output"]["items"][number];
export type UnmappedListing = components["schemas"]["UnmappedPageDto_Output"]["items"][number];
export type Suggestion = UnmappedListing["suggestions"][number];
export type ListingStatus = Listing["status"];

/** Lowest and highest of some numbers; null without any. */
export function range(values: readonly number[]): { min: number; max: number } | null {
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** Prices of a product's live variants (archived ones are not sold); all of them if every one is archived. */
export function priceRange(variants: readonly Pick<Variant, "basePrice" | "status">[]) {
  const live = variants.filter((v) => v.status === "active");
  return range((live.length > 0 ? live : variants).map((v) => v.basePrice));
}

/** Cost prices, when the user may see them (`costPrice` is null without finance:read). */
export function costRange(variants: readonly Pick<Variant, "costPrice">[]) {
  return range(variants.flatMap((v) => (v.costPrice === null ? [] : [v.costPrice])));
}

export function listingTotal(variants: readonly Pick<Variant, "listingCount">[]): number {
  return variants.reduce((n, v) => n + v.listingCount, 0);
}

/** A variant's name, or its attribute values when it has no name of its own. */
export function variantLabel(v: Pick<Variant, "name" | "attributes" | "sku">): string {
  if (v.name.trim()) return v.name;
  const values = Object.values(v.attributes).filter(Boolean);
  return values.length > 0 ? values.join(", ") : v.sku;
}

/** Image addresses typed one per line: the api takes https only, at most nine. */
export function parseImageUrls(text: string): { urls: string[]; invalid: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    urls: lines.filter((l) => /^https:\/\/\S+$/.test(l)),
    invalid: lines.filter((l) => !/^https:\/\/\S+$/.test(l)),
  };
}

/** Attribute names typed with commas ("Warna, Ukuran"): trimmed, without blanks and repeats. */
export function parseAttributeNames(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * The suggestion shown first for an unmapped listing: the same SKU always wins, then the closest name.
 * Name matches under 0.5 are left out: they mislead more than they help.
 */
export function bestSuggestion(item: Pick<UnmappedListing, "suggestions">): Suggestion | null {
  const ranked = [...item.suggestions]
    .filter((s) => s.reason === "sku" || s.score >= 0.5)
    .sort((a, b) => (a.reason === "sku" ? 0 : 1) - (b.reason === "sku" ? 0 : 1) || b.score - a.score);
  return ranked[0] ?? null;
}

/** Share of listings mapped, in whole percent, for the progress banner of L15. */
export function mappedPercent(summary: { total: number; mapped: number }): number {
  if (summary.total === 0) return 100;
  return Math.floor((summary.mapped / summary.total) * 100);
}

/** A field value of the product history as text: money fields are rupiah, lists joined, nothing a dash. */
export function historyValue(field: string, value: unknown, formatRupiah: (n: number) => string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return /price|cost/i.test(field) ? formatRupiah(value) : String(value);
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.map(String).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(", ");
  }
  return String(value);
}
