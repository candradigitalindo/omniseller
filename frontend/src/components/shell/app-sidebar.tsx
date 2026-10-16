"use client";

import { cn } from "cn";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Logo } from "@/components/common/logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { useCan } from "@/lib/session";
import { activeHref, type NavGroup, visibleNav } from "./nav";
import { UserMenu } from "./user-menu";

/**
 * The sidebar of DOKUMEN-UI-UX 6.2 and 7.1: 264 px, folding into a 72 px icon rail with tooltips; on phones
 * the same menu opens as a bottom sheet from the bottom navigation's "Menu".
 */
export function AppSidebar() {
  const pathname = usePathname();
  const can = useCan();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const groups = visibleNav(can);
  const active = activeHref(
    groups.flatMap((g) => g.items.map((i) => i.href)),
    pathname,
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 justify-center px-4 group-data-[collapsible=icon]:px-5">
        <Link href="/" aria-label="OmniSeller" onClick={() => isMobile && setOpenMobile(false)}>
          <Logo compact={state === "collapsed" && !isMobile} />
        </Link>
      </SidebarHeader>
      <SidebarContent className="group-data-[collapsible=icon]:overflow-y-auto">
        {groups.map((group) => (
          <SidebarCategory
            key={`${group.key}:${group.items.some((i) => i.href === active) ? active : ""}`}
            group={group}
            active={active}
            rail={state === "collapsed" && !isMobile}
            onNavigate={() => isMobile && setOpenMobile(false)}
          />
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t group-data-[collapsible=icon]:px-4">
        <UserMenu showName />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** A compact category that opens automatically when navigation enters it. The icon rail keeps all links. */
function SidebarCategory({
  group,
  active,
  rail,
  onNavigate,
}: {
  group: NavGroup;
  active: string | null;
  rail: boolean;
  onNavigate: () => void;
}) {
  const t = useTranslations("nav");
  const current = group.items.some((i) => i.href === active);
  const [open, setOpen] = useState(current);
  const id = useId();
  return (
    <SidebarGroup className="py-1">
      <SidebarGroupLabel asChild>
        <button
          type="button"
          hidden={rail}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "mb-1 h-10 w-full gap-2 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            current && "font-semibold text-primary-700",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{t(group.key)}</span>
          <span aria-hidden className="text-xs tabular-nums text-text-500">
            {group.items.length}
          </span>
          <ChevronDown
            aria-hidden
            className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")}
          />
        </button>
      </SidebarGroupLabel>
      <div id={id} hidden={!open && !rail}>
        <SidebarMenu aria-label={t(group.key)}>
          {group.items.map((item) => (
            <SidebarMenuItem key={item.key}>
              <SidebarMenuButton asChild isActive={item.href === active} tooltip={t(item.key)}>
                <Link href={item.href} aria-current={item.href === active ? "page" : undefined} onClick={onNavigate}>
                  <item.icon aria-hidden />
                  <span>{t(item.key)}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </div>
    </SidebarGroup>
  );
}
