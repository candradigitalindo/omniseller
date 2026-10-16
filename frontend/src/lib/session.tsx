"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { api, unwrap } from "./api/client";
import type { components } from "./api/schema";

export type Me = components["schemas"]["MeDto_Output"];
/** Permission codes as the api lists them (`order:read`, `inventory:adjust`, ...). */
export type Permission = Me["permissions"][number];

export const meQueryKey = ["me"] as const;

/** The signed-in user, the business, permissions, and scopes (`GET /v1/me`), refreshed while the app is in use. */
export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: () => unwrap(api.GET("/v1/me")),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

const SessionContext = createContext<Me | null>(null);

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  return <SessionContext.Provider value={me}>{children}</SessionContext.Provider>;
}

/** The session inside the app shell; pages outside it (sign in) never call this. */
export function useSession(): Me {
  const me = useContext(SessionContext);
  if (!me) throw new Error("useSession outside SessionProvider");
  return me;
}

/**
 * Whether the user holds a permission. Screens hide what the user may not do (DOKUMEN-UI-UX 7.1); the
 * api refuses it anyway (403).
 */
export function canIn(me: Pick<Me, "permissions">, permission: Permission): boolean {
  return me.permissions.includes(permission);
}

export function useCan(): (permission: Permission) => boolean {
  const me = useSession();
  return (permission) => canIn(me, permission);
}

/**
 * What the plan in force unlocks beyond its quotas (`plan.features`, backend doc 8.32), such as
 * `auto_process`. Screens offer only what the plan has; the api refuses the rest (422).
 */
export function useHasFeature(feature: string): boolean {
  return useSession().plan.features.includes(feature);
}

/** The business's time zone (`Asia/Jakarta` unless the owner changed it); dates on screen use it (PRD 13.2). */
export function useTimeZone(): string {
  return useSession().tenant.timezone;
}
