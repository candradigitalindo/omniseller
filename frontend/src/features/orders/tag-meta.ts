import type { components } from "@/lib/api/schema";

export type Tag = components["schemas"]["TagListDto_Output"]["items"][number];
export type TagRef = Pick<Tag, "id" | "name" | "color">;

/** A business keeps at most this many tags (backend `MAX_TAGS`, `tag.limit`). */
export const MAX_TAGS = 100;

/**
 * Colors a tag can wear: the categorical palette of DOKUMEN-UI-UX 13 in its fixed order, stored as hex by the
 * api. A tag shows its color as a dot beside its name, never as the text color.
 */
export const TAG_COLORS = [
  { hex: "#2A78D6", name: "blue" },
  { hex: "#EB6834", name: "orange" },
  { hex: "#1BAF7A", name: "green" },
  { hex: "#EDA100", name: "yellow" },
  { hex: "#E87BA4", name: "pink" },
  { hex: "#008300", name: "darkGreen" },
  { hex: "#4A3AA7", name: "purple" },
  { hex: "#E34948", name: "red" },
] as const;

/** The color a new tag gets: the next of the palette, so tags made one after another look apart. */
export function nextTagColor(count: number): string {
  return TAG_COLORS[count % TAG_COLORS.length]!.hex;
}

/** Whether every selected order carries a tag, some of them, or none: the boxes of "Beri tag". */
export type TagState = "all" | "some" | "none";

export function tagStates(
  orders: readonly { tags: readonly { id: string }[] }[],
  tagIds: readonly string[],
): Record<string, TagState> {
  const states: Record<string, TagState> = {};
  for (const id of tagIds) {
    const carrying = orders.filter((o) => o.tags.some((t) => t.id === id)).length;
    states[id] = carrying === 0 ? "none" : carrying === orders.length ? "all" : "some";
  }
  return states;
}

/**
 * A click on a box: on for every order, then off for every order. A tag that was on some orders goes on for
 * all, off for all, then back to as it was.
 */
export function nextTagState(state: TagState, original: TagState): TagState {
  if (state === "all") return "none";
  if (state === "none" && original === "some") return "some";
  return "all";
}

/**
 * What "Terapkan" sends (`POST /v1/orders/tags`): tags turned on go to every selected order, tags turned off
 * come off every one. A tag left on some orders is not touched.
 */
export function tagChanges(
  before: Record<string, TagState>,
  after: Record<string, TagState>,
): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const [id, state] of Object.entries(after)) {
    if (state === before[id]) continue;
    if (state === "all") add.push(id);
    if (state === "none") remove.push(id);
  }
  return { add, remove };
}

/** What is wrong with a tag name as typed: empty, longer than 30 characters, or another tag's (any case). */
export function tagNameProblem(
  name: string,
  tags: readonly TagRef[],
  selfId: string | null = null,
): "required" | "tooLong" | "taken" | null {
  const typed = name.trim();
  if (typed === "") return "required";
  if (typed.length > 30) return "tooLong";
  const lower = typed.toLowerCase();
  return tags.some((t) => t.id !== selfId && t.name.toLowerCase() === lower) ? "taken" : null;
}

/** Tags whose name holds the typed text (any case), in the api's order (by name). */
export function matchingTags<T extends TagRef>(tags: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q === "" ? [...tags] : tags.filter((t) => t.name.toLowerCase().includes(q));
}
