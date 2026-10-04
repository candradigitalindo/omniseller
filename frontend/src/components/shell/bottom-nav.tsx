"use client";

import { cn } from "cn";
import { Boxes, Home, Menu, ShoppingBag } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSidebar } from "@/components/ui/sidebar";
import { type Permission, useCan } from "@/lib/session";
import { isActive } from "./nav";

const TABS: { key: "home" | "orders" | "stock"; href: string; icon: typeof Home; permission?: Permission }[] = [
  { key: "home", href: "/", icon: Home },
  { key: "orders", href: "/pesanan", icon: ShoppingBag, permission: "order:read" },
  { key: "stock", href: "/stok", icon: Boxes, permission: "inventory:read" },
];

const itemClass =
  "flex min-w-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-text-500 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Phones (7.4): Home, Orders, Stock, and Menu, which opens every group as a bottom sheet. Chat joins when
 * its screen exists.
 */
export function BottomNav() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const can = useCan();
  const { setOpenMobile } = useSidebar();

  return (
    <nav
      aria-label={t("menu")}
      className="fixed inset-x-0 bottom-0 z-30 flex h-16 border-t bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {TABS.filter((tab) => !tab.permission || can(tab.permission)).map((tab) => {
        const active = isActive(tab.href, pathname);
        return (
          <Link key={tab.key} href={tab.href} className={cn(itemClass, active && "text-primary-600")}>
            <span className={cn("grid h-7 w-12 place-items-center rounded-full", active && "bg-primary-100")}>
              <tab.icon className="size-6" aria-hidden />
            </span>
            {t(tab.key)}
          </Link>
        );
      })}
      <button type="button" className={itemClass} onClick={() => setOpenMobile(true)}>
        <span className="grid h-7 w-12 place-items-center rounded-full">
          <Menu className="size-6" aria-hidden />
        </span>
        {t("menu")}
      </button>
    </nav>
  );
}
