"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { ClosingView } from "@/features/closure/closing-view";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { SessionProvider, useMe } from "@/lib/session";
import { AppSidebar } from "./app-sidebar";
import { BottomNav } from "./bottom-nav";
import { TopBar } from "./top-bar";

/** The skeleton of the shell while `/v1/me` loads: the final layout in grey, no spinner (8.6). */
function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh bg-canvas" aria-busy>
      <div className="hidden w-[264px] shrink-0 border-r bg-surface p-4 md:block">
        <Skeleton className="h-8 w-36" />
        <div className="mt-8 grid gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
      <div className="flex-1">
        <div className="h-14 border-b bg-surface" />
        <div className="grid gap-4 p-4 md:p-6">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}

/**
 * Every signed-in page: the session from `/v1/me` (a 401 sends the browser to `/masuk` through the api
 * client), the sidebar, the top bar, and the bottom navigation on phones.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations("shell");
  const tCommon = useTranslations("common");
  const me = useMe();

  if (me.isPending || (me.isError && me.error instanceof ApiError && me.error.status === 401)) return <ShellSkeleton />;
  if (me.isError) {
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas p-6">
        <div className="grid max-w-md gap-3 text-center">
          <h1 className="text-xl font-bold text-text-900">{t("sessionError")}</h1>
          <p className="text-text-700">{errorMessage(me.error)}</p>
          <Button className="justify-self-center" onClick={() => me.refetch()}>
            {tCommon("retry")}
          </Button>
        </div>
      </main>
    );
  }

  // an account closing (backend doc 8.36): its own page instead of the app
  if (me.data.tenant.status === "closing") {
    return (
      <SessionProvider me={me.data}>
        <ClosingView />
      </SessionProvider>
    );
  }

  return (
    <SessionProvider me={me.data}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0 bg-canvas">
          <TopBar />
          {/* room under the page for the phone's selection bar, as tall as the bar, above the bottom navigation */}
          <div className="mx-auto w-full max-w-[1440px] flex-1 px-4 pt-4 pb-24 max-md:has-[[data-slot=selection-bar]]:pb-[calc(var(--selection-bar-height,3.5rem)+6.5rem)] md:px-6 md:pt-6 md:pb-10">
            {children}
          </div>
        </SidebarInset>
        <BottomNav />
      </SidebarProvider>
    </SessionProvider>
  );
}
