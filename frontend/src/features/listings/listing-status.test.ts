import { describe, expect, it } from "vitest";
import { marketplaceItems, switchable } from "./listing-status";

describe("listing status on the marketplace", () => {
  it("switches listings not deleted, of stores whose connection works", () => {
    expect(switchable({ status: "active" }, true)).toBe(true);
    expect(switchable({ status: "inactive" }, true)).toBe(true);
    expect(switchable({ status: "banned" }, true)).toBe(true);
    expect(switchable({ status: "deleted" }, true)).toBe(false);
    expect(switchable({ status: "active" }, false)).toBe(false);
  });

  it("counts marketplace products: variants of one product, in one store, are one", () => {
    expect(
      marketplaceItems([
        { storeId: "S1", externalItemId: "100" },
        { storeId: "S1", externalItemId: "100" },
        { storeId: "S1", externalItemId: "101" },
        { storeId: "S2", externalItemId: "100" },
      ]),
    ).toBe(3);
    expect(marketplaceItems([])).toBe(0);
  });
});
