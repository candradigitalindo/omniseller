import { describe, expect, it } from "vitest";
import type { Permission } from "@/lib/session";
import { isActive, visibleNav } from "./nav";

const holding =
  (...perms: Permission[]) =>
  (p: Permission) =>
    perms.includes(p);

describe("sidebar (DOKUMEN-UI-UX 7.1)", () => {
  it("shows only screens that exist, and only to users with the permission", () => {
    const owner = visibleNav(holding("order:read", "inventory:read", "catalog:read", "settings:store"));
    expect(owner.map((g) => [g.key, g.items.map((i) => i.key)])).toEqual([
      ["groupHome", ["overview"]],
      ["groupSales", ["orders", "returns"]],
      ["groupStock", ["stock"]],
      ["groupSettings", ["stores"]],
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
});
