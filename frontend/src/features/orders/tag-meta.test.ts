import { describe, expect, it } from "vitest";
import {
  matchingTags,
  nextTagColor,
  nextTagState,
  TAG_COLORS,
  tagChanges,
  tagNameProblem,
  tagStates,
} from "./tag-meta";

const tag = (id: string, name: string) => ({ id, name, color: null });

describe("tags on many orders", () => {
  const orders = [{ tags: [{ id: "A" }, { id: "B" }] }, { tags: [{ id: "A" }] }, { tags: [] }];

  it("says whether all, some, or none of the orders carry each tag", () => {
    expect(tagStates(orders, ["A", "B", "C"])).toEqual({ A: "some", B: "some", C: "none" });
    expect(tagStates(orders.slice(0, 2), ["A", "B"])).toEqual({ A: "all", B: "some" });
    expect(tagStates([], ["A"])).toEqual({ A: "none" });
  });

  it("turns a box on, then off, and a tag on some orders back to as it was", () => {
    expect(nextTagState("none", "none")).toBe("all");
    expect(nextTagState("all", "none")).toBe("none");
    expect(nextTagState("all", "all")).toBe("none");
    expect(nextTagState("none", "all")).toBe("all");
    expect(nextTagState("some", "some")).toBe("all");
    expect(nextTagState("all", "some")).toBe("none");
    expect(nextTagState("none", "some")).toBe("some");
  });

  it("sends tags turned on and off, and leaves alone a tag kept on some orders", () => {
    const before = { A: "all", B: "some", C: "none", D: "some" } as const;
    expect(tagChanges(before, { A: "none", B: "all", C: "all", D: "some" })).toEqual({
      add: ["B", "C"],
      remove: ["A"],
    });
    expect(tagChanges(before, { ...before })).toEqual({ add: [], remove: [] });
    expect(tagChanges(before, { ...before, D: "none" })).toEqual({ add: [], remove: ["D"] });
  });
});

describe("tag names and colors", () => {
  const tags = [tag("1", "Prioritas"), tag("2", "Grosir")];

  it("needs a name of 1 to 30 characters that no other tag has, in any case", () => {
    expect(tagNameProblem("  ", tags)).toBe("required");
    expect(tagNameProblem("x".repeat(31), tags)).toBe("tooLong");
    expect(tagNameProblem(` ${"x".repeat(30)} `, tags)).toBeNull();
    expect(tagNameProblem(" prioritas ", tags)).toBe("taken");
    // a tag keeps its own name
    expect(tagNameProblem("PRIORITAS", tags, "1")).toBeNull();
    expect(tagNameProblem("Mudah pecah", tags)).toBeNull();
  });

  it("finds tags by part of their name", () => {
    expect(matchingTags(tags, " ROS ").map((t) => t.id)).toEqual(["2"]);
    expect(matchingTags(tags, "").map((t) => t.id)).toEqual(["1", "2"]);
    expect(matchingTags(tags, "cod")).toEqual([]);
  });

  it("gives new tags the palette in its order", () => {
    expect(nextTagColor(0)).toBe(TAG_COLORS[0].hex);
    expect(nextTagColor(3)).toBe(TAG_COLORS[3].hex);
    expect(nextTagColor(8)).toBe(TAG_COLORS[0].hex);
    expect(nextTagColor(9)).toBe(TAG_COLORS[1].hex);
  });
});
