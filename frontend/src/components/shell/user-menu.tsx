"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { LogOut, Moon, UserRound } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { leaveTo } from "@/lib/navigate";
import { useSession } from "@/lib/session";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/**
 * The user's avatar (initials, 32 px), roles, their account page, the light or dark theme, and signing out
 * (7.1, bottom).
 */
export function UserMenu({ showName = false }: { showName?: boolean }) {
  const t = useTranslations("shell");
  const me = useSession();
  const queryClient = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();
  const logout = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/auth/logout")),
    onSettled: () => {
      queryClient.clear();
      leaveTo("/masuk");
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-lg p-1 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring",
          showName && "w-full p-2",
        )}
        aria-label={me.user.name}
      >
        <Avatar className="size-8">
          <AvatarFallback className="bg-primary-100 text-sm font-semibold text-primary-600">
            {initials(me.user.name)}
          </AvatarFallback>
        </Avatar>
        {showName ? (
          <span className="grid min-w-0 group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold text-text-900">{me.user.name}</span>
            <span className="truncate text-[13px] text-text-500">{me.roles.map((r) => r.name).join(", ")}</span>
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-64">
        <DropdownMenuLabel className="grid gap-0.5 font-normal">
          <span className="truncate font-semibold text-text-900">{me.user.name}</span>
          <span className="truncate text-[13px] text-text-500">{me.user.email}</span>
          <span className="truncate text-[13px] text-text-500">{me.tenant.name}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/akun">
            <UserRound aria-hidden />
            {t("account")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setTheme(resolvedTheme === "dark" ? "light" : "dark");
          }}
        >
          <Moon aria-hidden />
          <span className="flex-1">{t("darkMode")}</span>
          <Switch checked={resolvedTheme === "dark"} aria-hidden tabIndex={-1} />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout.mutate()} disabled={logout.isPending}>
          <LogOut aria-hidden />
          {logout.isPending ? t("loggingOut") : t("logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
