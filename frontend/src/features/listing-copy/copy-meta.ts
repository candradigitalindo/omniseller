import type { Tone } from "@/components/common/page";
import type { components, operations } from "@/lib/api/schema";

export type Copy = components["schemas"]["CopyDto_Output"];
export type DraftItem = components["schemas"]["DraftPageDto_Output"]["items"][number];
export type Draft = components["schemas"]["DraftDto_Output"];
export type DraftProblem = Draft["problems"][number];
export type DraftUpdate = components["schemas"]["UpdateDraftDto"];
export type Category = components["schemas"]["CategoryPageDto_Output"]["items"][number];
export type CategoryDetail = components["schemas"]["CategoryDetailDto_Output"];
export type CategoryRules = NonNullable<CategoryDetail["rules"]>;
export type RuleAttribute = CategoryRules["attributes"][number];
export type DraftQuery = NonNullable<operations["ListingDraftsController_list"]["parameters"]["query"]>;

/** Copy status pills (8.5): blue while the worker prepares, green when the drafts are ready. */
export const COPY_TONE: Record<Copy["status"], Tone> = {
  preparing: "info",
  ready: "success",
  failed: "danger",
  cancelled: "neutral",
};

export const DRAFT_TONE: Record<DraftItem["status"], Tone> = {
  preparing: "info",
  draft: "neutral",
  publishing: "info",
  published: "success",
  failed: "danger",
};

/** Items the worker is done with, of all the copy's items. */
export function copyProgress(c: Pick<Copy, "itemsTotal" | "itemsDrafted" | "itemsSkipped" | "itemsFailed">): number {
  if (c.itemsTotal <= 0) return 0;
  return Math.min(100, Math.round(((c.itemsDrafted + c.itemsSkipped + c.itemsFailed) / c.itemsTotal) * 100));
}

/** The drafts queues: what to fix, what can go, what failed, what went. */
export const DRAFT_TABS = ["all", "fix", "ready", "failed", "published"] as const;
export type DraftTab = (typeof DRAFT_TABS)[number];

export function draftTabOf(value: string | null): DraftTab {
  return DRAFT_TABS.find((t) => t === value) ?? "all";
}

export const DRAFT_TAB_QUERY: Record<DraftTab, Pick<DraftQuery, "status" | "blocking">> = {
  all: {},
  fix: { status: "draft", blocking: "true" },
  ready: { status: "draft", blocking: "false" },
  failed: { status: "failed" },
  published: { status: "published" },
};

/** Drafts the api accepts for publishing: edited or failed, without a blocking problem. */
export function publishable(d: Pick<DraftItem, "status" | "blockingProblems">): boolean {
  return (d.status === "draft" || d.status === "failed") && d.blockingProblems === 0;
}

/** Drafts that may still change: the api edits only `draft` and `failed` ones. */
export function editable(d: Pick<DraftItem, "status">): boolean {
  return d.status === "draft" || d.status === "failed";
}

/** The worker is on it: the list and the editor keep asking until it is done. */
export function working(d: Pick<DraftItem, "status">): boolean {
  return d.status === "preparing" || d.status === "publishing";
}

/** "Rp 55.000" or "Rp 55.000 – Rp 57.000" from the variants' prices. */
export function priceRange(min: number | null, max: number | null, rupiah: (n: number) => string): string {
  if (min === null || max === null) return "—";
  return min === max ? rupiah(min) : `${rupiah(min)} – ${rupiah(max)}`;
}

/** Problems of one part of a draft (`title`, `attributes.100134`, `variants.k1.sku`, ...). */
export function problemsAt(problems: readonly DraftProblem[], field: string): DraftProblem[] {
  return problems.filter((p) => p.field === field || p.field.startsWith(`${field}.`));
}

// ---- the editor ----

export interface AttributeValue {
  /** chosen from the category's list */
  valueIds: string[];
  /** typed, when the attribute takes text */
  text: string;
  unit: string;
}

export interface EditState {
  title: string;
  description: string;
  /** "": no brand */
  brand: string;
  attributes: Record<string, AttributeValue>;
  /** source URLs in their order */
  images: string[];
  weightG: string;
  length: string;
  width: string;
  height: string;
  condition: "new" | "used";
  /** "": ships at once */
  preOrderDays: string;
  itemSku: string;
  variationNames: string[];
  variants: { key: string; sku: string; price: string; options: string[] }[];
}

/** What the editor starts from: the draft as the api has it. */
export function editState(d: Draft): EditState {
  return {
    title: d.title,
    description: d.description,
    brand: d.brand?.name ?? "",
    attributes: Object.fromEntries(
      d.attributes.map((a) => [
        a.attributeId,
        {
          valueIds: a.values.flatMap((v) => (v.valueId ? [v.valueId] : [])),
          text: a.values
            .filter((v) => !v.valueId && v.name)
            .map((v) => v.name)
            .join(", "),
          unit: a.values.find((v) => v.unit)?.unit ?? "",
        },
      ]),
    ),
    images: d.images.map((i) => i.sourceUrl),
    weightG: d.weightG === null ? "" : String(d.weightG),
    length: d.dimensionsMm ? String(d.dimensionsMm.length) : "",
    width: d.dimensionsMm ? String(d.dimensionsMm.width) : "",
    height: d.dimensionsMm ? String(d.dimensionsMm.height) : "",
    condition: d.condition,
    preOrderDays: d.preOrderDays === null ? "" : String(d.preOrderDays),
    itemSku: d.itemSku ?? "",
    variationNames: [...d.variationNames],
    variants: d.variants.map((v) => ({
      key: v.key,
      sku: v.sku ?? "",
      price: String(v.price),
      options: [...v.options],
    })),
  };
}

const WHOLE = /^\d+$/;

/** An attribute value as the api takes it: chosen ids, then typed names (split at commas). */
export function attributeValues(
  v: AttributeValue,
): { valueId?: string | null; name?: string | null; unit?: string | null }[] {
  const chosen = v.valueIds.map((valueId) => ({ valueId }));
  const typed = v.text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, ...(v.unit ? { unit: v.unit } : {}) }));
  return [...chosen, ...typed];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Attributes as the api would get them: empty ones left out, in id order. */
function attributeBody(attributes: Record<string, AttributeValue>) {
  return Object.entries(attributes)
    .map(([attributeId, v]) => ({ attributeId, values: attributeValues(v) }))
    .filter((a) => a.values.length > 0)
    .sort((a, b) => a.attributeId.localeCompare(b.attributeId));
}

/** What the editor checks before saving, keyed like the api's problem fields. */
export function editProblems(s: EditState): Record<string, "required" | "whole" | "dimensions"> {
  const out: Record<string, "required" | "whole" | "dimensions"> = {};
  if (!s.title.trim()) out.title = "required";
  if (s.weightG.trim() && !WHOLE.test(s.weightG.trim())) out.weight = "whole";
  const dims = [s.length, s.width, s.height].map((x) => x.trim());
  if (dims.some(Boolean) && !dims.every((x) => WHOLE.test(x) && Number(x) > 0)) out.dimensions = "dimensions";
  if (s.preOrderDays.trim() && !WHOLE.test(s.preOrderDays.trim())) out.preOrderDays = "whole";
  s.variants.forEach((v) => {
    if (!WHOLE.test(v.price.trim())) out[`variants.${v.key}.price`] = "whole";
  });
  return out;
}

/**
 * Only what changed goes to the api: a description sent unchanged would replace the source's HTML with plain
 * text, and attributes and variants are replaced as a whole when sent.
 */
export function draftPatch(before: EditState, after: EditState): DraftUpdate {
  const patch: DraftUpdate = {};
  if (after.title !== before.title) patch.title = after.title.trim();
  if (after.description !== before.description) patch.description = after.description;
  if (after.brand !== before.brand) patch.brand = after.brand.trim() ? { name: after.brand.trim() } : null;
  // an attribute only opened and left empty is no change
  if (!same(attributeBody(after.attributes), attributeBody(before.attributes))) {
    patch.attributes = attributeBody(after.attributes);
  }
  if (!same(after.images, before.images)) patch.images = after.images;
  if (after.weightG !== before.weightG && WHOLE.test(after.weightG.trim())) patch.weightG = Number(after.weightG);
  const dims = (s: EditState) => [s.length, s.width, s.height].map((x) => x.trim());
  if (!same(dims(after), dims(before))) {
    const [length, width, height] = dims(after).map(Number) as [number, number, number];
    patch.dimensionsMm = dims(after).every((x) => x === "") ? null : { length, width, height };
  }
  if (after.condition !== before.condition) patch.condition = after.condition;
  if (after.preOrderDays !== before.preOrderDays) {
    patch.preOrderDays = after.preOrderDays.trim() ? Number(after.preOrderDays) : null;
  }
  if (after.itemSku !== before.itemSku) patch.itemSku = after.itemSku.trim() || null;
  if (!same(after.variationNames, before.variationNames))
    patch.variationNames = after.variationNames.map((n) => n.trim());
  if (!same(after.variants, before.variants)) {
    patch.variants = after.variants.map((v) => ({
      key: v.key,
      sku: v.sku.trim() || null,
      price: Number(v.price),
      options: v.options.map((o) => o.trim()),
    }));
  }
  return patch;
}

/** Required attributes first, then the others, each by name. */
export function sortedAttributes(rules: CategoryRules): RuleAttribute[] {
  return [...rules.attributes].sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
}

/** Attributes required only when another one has a value (Tokopedia & Shop) and that value is chosen. */
export function requiredNow(a: RuleAttribute, attributes: Record<string, AttributeValue>): boolean {
  if (a.required) return true;
  return a.requiredWhen.some((w) => attributes[w.attributeId]?.valueIds.includes(w.valueId) ?? false);
}
