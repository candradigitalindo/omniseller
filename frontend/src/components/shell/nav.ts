import {
  ArrowLeftRight,
  Boxes,
  ClipboardCheck,
  LayoutDashboard,
  type LucideIcon,
  Package,
  Plug,
  RotateCcw,
  ShoppingBag,
} from "lucide-react";
import type { Permission } from "@/lib/session";

type NavKey = "overview" | "orders" | "returns" | "products" | "stock" | "stockCounts" | "transfers" | "stores";
type GroupKey = "groupHome" | "groupSales" | "groupCatalog" | "groupStock" | "groupSettings";

export interface NavItem {
  key: NavKey;
  href: string;
  icon: LucideIcon;
  /** Shown only to users holding it (DOKUMEN-UI-UX 7.1, "Izin minimal"); none: everyone. */
  permission?: Permission;
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
      { key: "returns", href: "/retur", icon: RotateCcw, permission: "order:read", ready: false },
    ],
  },
  {
    key: "groupCatalog",
    items: [{ key: "products", href: "/produk", icon: Package, permission: "catalog:read", ready: false }],
  },
  {
    key: "groupStock",
    items: [
      { key: "stock", href: "/stok", icon: Boxes, permission: "inventory:read", ready: true },
      { key: "stockCounts", href: "/stok/opname", icon: ClipboardCheck, permission: "inventory:count", ready: false },
      {
        key: "transfers",
        href: "/stok/transfer",
        icon: ArrowLeftRight,
        permission: "inventory:transfer",
        ready: false,
      },
    ],
  },
  {
    key: "groupSettings",
    items: [{ key: "stores", href: "/integrasi", icon: Plug, permission: "settings:store", ready: true }],
  },
];

/** Groups with the items this user may open now; empty groups disappear. */
export function visibleNav(can: (p: Permission) => boolean): NavGroup[] {
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.ready && (!i.permission || can(i.permission))),
  })).filter((g) => g.items.length > 0);
}

/** Whether `pathname` is inside the item: `/` only itself, others their subtree. */
export function isActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
