import { describe, expect, it } from "vitest";
import type { Permission } from "@/lib/session";
import { activeHref, isActive, NAV, visibleNav } from "./nav";

const holding =
  (...perms: Permission[]) =>
  (p: Permission) =>
    perms.includes(p);

describe("sidebar (DOKUMEN-UI-UX 7.1)", () => {
  it("groups each screen once by purpose and leaves out empty or forbidden categories", () => {
    const owner = visibleNav(() => true);
    expect(owner.map((g) => [g.key, g.items.map((i) => i.key)])).toEqual([
      ["groupHome", ["overview", "notifications"]],
      ["groupSales", ["orders", "orderRules", "returns"]],
      ["groupCatalog", ["products", "listings", "copyListings"]],
      ["groupStock", ["stock", "warehouses", "stockHistory", "stockCounts", "transfers", "restock"]],
      ["groupShipping", ["shipping", "printers", "courierHours"]],
      ["groupAnalytics", ["salesReport", "teamPerformance", "dataExport"]],
      ["groupAccess", ["team", "auditLog"]],
      ["groupBusiness", ["stores", "migration", "businessProfile", "subscription"]],
    ]);
    const hrefs = NAV.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(visibleNav(holding()).map((g) => [g.key, g.items.map((i) => i.key)])).toEqual([
      ["groupHome", ["overview", "notifications"]],
    ]);
    const warehouse = visibleNav(holding("inventory:read", "inventory:count", "inventory:transfer"));
    expect(warehouse.map((g) => g.key)).toEqual(["groupHome", "groupStock"]);
    expect(warehouse.find((g) => g.key === "groupStock")?.items.map((i) => i.key)).toEqual([
      "stock",
      "warehouses",
      "stockHistory",
      "stockCounts",
      "transfers",
      "restock",
    ]);
  });

  it("follows actual permissions of any custom role instead of names or plans", () => {
    const categories = (permissions: Permission[]) =>
      visibleNav(holding(...permissions)).map((g) => [g.key, g.items.map((i) => i.key)]);
    expect(categories(["settings:user", "audit:read"])).toEqual([
      ["groupHome", ["overview", "notifications"]],
      ["groupAnalytics", ["teamPerformance"]],
      ["groupAccess", ["team", "auditLog"]],
    ]);
    expect(categories(["settings:billing"])).toEqual([
      ["groupHome", ["overview", "notifications"]],
      ["groupBusiness", ["businessProfile", "subscription"]],
    ]);
    expect(categories(["catalog:read", "price:write"])).toEqual([
      ["groupHome", ["overview", "notifications"]],
      ["groupCatalog", ["products", "listings"]],
    ]);
    for (const permission of ["shipment:pack", "shipment:print", "shipment:handover"] as const) {
      expect(
        visibleNav(holding(permission))
          .find((g) => g.key === "groupShipping")
          ?.items.map((i) => i.key),
      ).toContain("shipping");
    }
    expect(categories(["settings:warehouse"])).toEqual([
      ["groupHome", ["overview", "notifications"]],
      ["groupShipping", ["printers", "courierHours"]],
    ]);
    expect(categories(["order:accept", "data:export", "settings:store"])).toEqual([
      ["groupHome", ["overview", "notifications"]],
      ["groupSales", ["orderRules"]],
      ["groupAnalytics", ["dataExport"]],
      ["groupBusiness", ["stores", "migration"]],
    ]);
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
