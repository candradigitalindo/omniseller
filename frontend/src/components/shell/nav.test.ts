import { describe, expect, it } from "vitest";
import type { Permission } from "@/lib/session";
import { activeHref, isActive, visibleNav } from "./nav";

const holding =
  (...perms: Permission[]) =>
  (p: Permission) =>
    perms.includes(p);

describe("sidebar (DOKUMEN-UI-UX 7.1)", () => {
  it("shows only screens that exist, and only to users with the permission", () => {
    const owner = visibleNav(holding("order:read", "inventory:read", "catalog:read", "catalog:map", "settings:store"));
    expect(owner.map((g) => [g.key, g.items.map((i) => i.key)])).toEqual([
      ["groupHome", ["overview"]],
      ["groupSales", ["orders", "returns"]],
      ["groupCatalog", ["products", "listings"]],
      ["groupStock", ["stock"]],
      ["groupSettings", ["stores"]],
    ]);
    const warehouse = visibleNav(holding("inventory:read", "inventory:count", "inventory:transfer"));
    expect(warehouse.find((g) => g.key === "groupStock")?.items.map((i) => i.key)).toEqual([
      "stock",
      "stockCounts",
      "transfers",
    ]);
    // a role without order:read keeps the overview and loses the sales group
    expect(visibleNav(holding("inventory:read")).map((g) => g.key)).toEqual(["groupHome", "groupStock"]);
  });

  it("marks the home only on itself and other items on their whole subtree", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/pesanan")).toBe(false);
    expect(isActive("/pesanan", "/pesanan/01J")).toBe(true);
    expect(isActive("/stok", "/stokopname")).toBe(false);
  });

  it("marks only the most specific item", () => {
    const hrefs = ["/", "/stok", "/stok/opname", "/stok/transfer"];
    expect(activeHref(hrefs, "/stok/opname/01J")).toBe("/stok/opname");
    expect(activeHref(hrefs, "/stok")).toBe("/stok");
    expect(activeHref(hrefs, "/")).toBe("/");
    expect(activeHref(hrefs, "/pesanan")).toBeNull();
  });
});
