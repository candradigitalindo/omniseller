"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { isActive, NAV } from "./nav";
import { Notifications } from "./notifications";
import { UserMenu } from "./user-menu";

/** The 56 px top bar (6.2, 6.3): fold the sidebar, where the user is, notifications; the avatar on phones. */
export function TopBar() {
  const t = useTranslations("nav");
  const tShell = useTranslations("shell");
  const pathname = usePathname();
  const here = NAV.flatMap((g) => g.items)
    .filter((i) => isActive(i.href, pathname))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-surface px-3 md:px-4">
      <SidebarTrigger className="hidden md:inline-flex" aria-label={tShell("toggleSidebar")} />
      <p className="min-w-0 flex-1 truncate text-center text-base font-semibold text-text-900 md:text-left md:text-[15px] md:font-medium md:text-text-700">
        {here ? t(here.key) : null}
      </p>
      <Notifications />
      <div className="md:hidden">
        <UserMenu />
      </div>
    </header>
  );
}
