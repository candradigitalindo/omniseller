import { describe, expect, it } from "vitest";
import type { Permission } from "@/lib/session";
import { activeHref, isActive, visibleNav } from "./nav";

const holding =
  (...perms: Permission[]) =>
  (p: Permission) =>
    perms.includes(p);

describe("sidebar (DOKUMEN-UI-UX 7.1)", () => {
  it("shows only screens that exist, and only to users with the permission", () => {
    const owner = visibleNav(
      holding("order:read", "inventory:read", "catalog:read", "catalog:map", "report:read", "settings:store"),
    );
    expect(owner.map((g) => [g.key, g.items.map((i) => i.key)])).toEqual([
      ["groupHome", ["overview"]],
      ["groupSales", ["orders", "returns"]],
      ["groupCatalog", ["products", "listings"]],
      ["groupStock", ["stock", "warehouses", "stockHistory", "restock"]],
      ["groupAnalytics", ["salesReport"]],
      ["groupSettings", ["stores", "notifications", "migration"]],
    ]);
    // the audit log is for audit:read (Owner and Admin), next to the team
    expect(
      visibleNav(holding("settings:user", "audit:read"))
        .find((g) => g.key === "groupSettings")
        ?.items.map((i) => i.key),
    ).toEqual(["team", "auditLog", "notifications"]);
    // the business profile and its legal papers are the Owner's (settings:billing)
    expect(
      visibleNav(holding("settings:billing"))
        .find((g) => g.key === "groupSettings")
        ?.items.map((i) => i.key),
    ).toEqual(["notifications", "businessProfile"]);
    // copying listings needs catalog:write, which this role does not hold
    expect(owner.find((g) => g.key === "groupCatalog")?.items.map((i) => i.key)).not.toContain("copyListings");
    const warehouse = visibleNav(holding("inventory:read", "inventory:count", "inventory:transfer"));
    expect(warehouse.find((g) => g.key === "groupStock")?.items.map((i) => i.key)).toEqual([
      "stock",
      "warehouses",
      "stockHistory",
      "stockCounts",
      "transfers",
      "restock",
    ]);
    // the sales report needs report:read (backend 8.20), so the warehouse role does not see Analitik
    expect(warehouse.map((g) => g.key)).not.toContain("groupAnalytics");
    // shipping shows to anyone holding one of its permissions
    const packer = visibleNav(holding("order:read", "shipment:pack"));
    expect(packer.find((g) => g.key === "groupSales")?.items.map((i) => i.key)).toEqual([
      "orders",
      "shipping",
      "returns",
    ]);
    expect(
      visibleNav(holding("shipment:handover"))
        .find((g) => g.key === "groupSales")
        ?.items.map((i) => i.key),
    ).toEqual(["shipping"]);
    // a role without order:read keeps the overview and loses the sales group; everyone has their own
    // notification settings
    expect(visibleNav(holding("inventory:read")).map((g) => g.key)).toEqual([
      "groupHome",
      "groupStock",
      "groupSettings",
    ]);
    // printers show to whoever prints or manages warehouses; team and data export to their own permission
    expect(
      visibleNav(holding("shipment:print", "settings:user", "data:export"))
        .find((g) => g.key === "groupSettings")
        ?.items.map((i) => i.key),
    ).toEqual(["team", "printers", "notifications", "dataExport"]);
    // courier cut-offs and operating hours belong to whoever manages the warehouses
    expect(
      visibleNav(holding("settings:warehouse"))
        .find((g) => g.key === "groupSettings")
        ?.items.map((i) => i.key),
    ).toEqual(["printers", "courierHours", "notifications"]);
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
