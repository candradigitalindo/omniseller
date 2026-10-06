import type { components } from "@/lib/api/schema";

export type Agent = components["schemas"]["PrintAgentDto_Output"];
export type LabelTemplate = components["schemas"]["LabelTemplateDto_Output"];

/** What the strip under a marketplace label may show (FR-SHP-16), in the order the page lists them. */
export const LABEL_OPTIONS = [
  "showSku",
  "showVariant",
  "showBin",
  "showBuyerNote",
  "showTags",
] as const satisfies readonly (keyof LabelTemplate)[];
