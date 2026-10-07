"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Monitor, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useTimeZone } from "@/lib/session";
import { deviceName, isPhone, sessionsQueryKey } from "./security-meta";

/**
 * "Perangkat yang masuk" on Akun saya (UI L41b, PRD FR-USR-06, backend doc 8.30): where this account is
 * signed in, signing one device out, or every device but this one.
 */
export function SessionsCard() {
  const t = useTranslations("account");
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const sessions = useQuery({ queryKey: sessionsQueryKey, queryFn: () => unwrap(api.GET("/v1/me/sessions")) });
  const nameOf = (s: { browser: string | null; os: string | null }) =>
    deviceName(s, (browser, os) => t("deviceName", { browser, os }), t("unknownDevice"));

  const revoke = useMutation({
    mutationFn: (s: { id: string; browser: string | null; os: string | null }) =>
      unwrap(api.DELETE("/v1/me/sessions/{id}", { params: { path: { id: s.id } } })),
    onSuccess: (_, s) => {
      toast.success(t("signedOut", { device: nameOf(s) }));
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    },
  });
  const revokeOthers = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/me/sessions/revoke-others")),
    onSuccess: (r) => {
      setConfirming(false);
      toast.success(t("signedOutOthers", { count: r.revoked }));
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const others = sessions.data?.items.filter((s) => !s.current).length ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("sessionsTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("sessionsBody")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {sessions.isPending ? (
          <Skeleton className="h-28" />
        ) : sessions.isError ? (
          <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />
        ) : (
          <>
            <ul aria-label={t("sessionsTitle")} className="divide-y rounded-lg border">
              {sessions.data.items.map((s) => {
                const Icon = isPhone(s.os) ? Smartphone : Monitor;
                const name = nameOf(s);
                return (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-3">
                    <Icon className="size-5 shrink-0 text-text-500" aria-hidden />
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-900">
                        {name}
                        {s.current ? <StatusPill tone="success">{t("thisDevice")}</StatusPill> : null}
                      </span>
                      <span className="text-[13px] text-text-500">
                        {t("sessionMeta", {
                          ip: s.ip ?? "—",
                          signedIn: formatDateTime(s.createdAt, tz),
                          lastSeen: formatRelative(s.lastSeenAt, tz),
                        })}
                      </span>
                    </div>
                    {s.current ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("signOutNamed", { device: name })}
                        loading={revoke.isPending && revoke.variables?.id === s.id}
                        onClick={() => revoke.mutate(s)}
                      >
                        {t("signOut")}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {others === 0 ? (
              <p className="text-sm text-text-500">{t("noOtherSessions")}</p>
            ) : (
              <Button variant="secondary" className="justify-self-start" onClick={() => setConfirming(true)}>
                <LogOut aria-hidden />
                {t("signOutOthers")}
              </Button>
            )}
          </>
        )}
      </CardContent>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("signOutOthersTitle")}</DialogTitle>
            <DialogDescription>{t("signOutOthersBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
              {t("signOutOthers")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
