import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  ClipboardCheck,
  LayoutDashboard,
  type LucideIcon,
  Package,
  PackagePlus,
  Plug,
  RotateCcw,
  ShoppingBag,
  Store,
  Truck,
} from "lucide-react";
import type { Permission } from "@/lib/session";

type NavKey =
  | "overview"
  | "orders"
  | "shipping"
  | "returns"
  | "products"
  | "listings"
  | "stock"
  | "stockCounts"
  | "transfers"
  | "restock"
  | "salesReport"
  | "stores";
type GroupKey = "groupHome" | "groupSales" | "groupCatalog" | "groupStock" | "groupAnalytics" | "groupSettings";

export interface NavItem {
  key: NavKey;
  href: string;
  icon: LucideIcon;
  /**
   * Shown only to users holding it, or one of them for a list (DOKUMEN-UI-UX 7.1, "Izin minimal"); none:
   * everyone.
   */
  permission?: Permission | readonly Permission[];
  /**
   * Whether the screen exists in this web app yet. Items of screens still to come are hidden, not shown
   * disabled (7.1: "disembunyikan sampai fiturnya aktif").
   */
  ready: boolean;
}

export interface NavGroup {
  key: GroupKey;
  items: NavItem[];
}

/** The sidebar of DOKUMEN-UI-UX 7.1, in its order. */
export const NAV: readonly NavGroup[] = [
  { key: "groupHome", items: [{ key: "overview", href: "/", icon: LayoutDashboard, ready: true }] },
  {
    key: "groupSales",
    items: [
      { key: "orders", href: "/pesanan", icon: ShoppingBag, permission: "order:read", ready: true },
      {
        key: "shipping",
        href: "/pengiriman",
        icon: Truck,
        permission: ["shipment:pack", "shipment:print", "shipment:handover"],
        ready: true,
      },
      { key: "returns", href: "/retur", icon: RotateCcw, permission: "order:read", ready: true },
    ],
  },
  {
    key: "groupCatalog",
    items: [
      { key: "products", href: "/produk", icon: Package, permission: "catalog:read", ready: true },
      { key: "listings", href: "/listing", icon: Store, permission: "catalog:map", ready: true },
    ],
  },
  {
    key: "groupStock",
    items: [
      { key: "stock", href: "/stok", icon: Boxes, permission: "inventory:read", ready: true },
      { key: "stockCounts", href: "/stok/opname", icon: ClipboardCheck, permission: "inventory:count", ready: true },
      {
        key: "transfers",
        href: "/stok/transfer",
        icon: ArrowLeftRight,
        permission: "inventory:transfer",
        ready: true,
      },
      { key: "restock", href: "/stok/restock", icon: PackagePlus, permission: "inventory:read", ready: true },
    ],
  },
  {
    key: "groupAnalytics",
    items: [
      { key: "salesReport", href: "/laporan/penjualan", icon: BarChart3, permission: "report:read", ready: true },
    ],
  },
  {
    key: "groupSettings",
    items: [{ key: "stores", href: "/integrasi", icon: Plug, permission: "settings:store", ready: true }],
  },
];

function allowed(permission: NavItem["permission"], can: (p: Permission) => boolean): boolean {
  if (!permission) return true;
  return typeof permission === "string" ? can(permission) : permission.some(can);
}

/** Groups with the items this user may open now; empty groups disappear. */
export function visibleNav(can: (p: Permission) => boolean): NavGroup[] {
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.ready && allowed(i.permission, can)),
  })).filter((g) => g.items.length > 0);
}

/** Whether `pathname` is inside the item: `/` only itself, others their subtree. */
export function isActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The one item to mark for `pathname`: the most specific match, so `/stok/opname` marks "Stock Opname"
 * and not also "Stok".
 */
export function activeHref(hrefs: readonly string[], pathname: string): string | null {
  return hrefs.filter((h) => isActive(h, pathname)).sort((a, b) => b.length - a.length)[0] ?? null;
}
