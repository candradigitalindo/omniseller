"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
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
import { activeHref, visibleNav } from "./nav";
import { UserMenu } from "./user-menu";

/**
 * The sidebar of DOKUMEN-UI-UX 6.2 and 7.1: 264 px, folding into a 72 px icon rail with tooltips; on phones
 * the same menu opens as a bottom sheet from the bottom navigation's "Menu".
 */
export function AppSidebar() {
  const t = useTranslations("nav");
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
      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.key}>
            <SidebarGroupLabel>{t(group.key)}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.key}>
                  <SidebarMenuButton asChild isActive={item.href === active} tooltip={t(item.key)}>
                    <Link href={item.href} onClick={() => isMobile && setOpenMobile(false)}>
                      <item.icon aria-hidden />
                      <span>{t(item.key)}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t group-data-[collapsible=icon]:px-4">
        <UserMenu showName />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
