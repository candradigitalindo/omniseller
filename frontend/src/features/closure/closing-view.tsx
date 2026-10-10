"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, ExternalLink, LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { channelLabel } from "@/components/common/channel";
import { ErrorState } from "@/components/common/page";
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
import { DataExportView } from "@/features/settings/data-export";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatDate, formatDateTime } from "@/lib/format";
import { leaveTo } from "@/lib/navigate";
import { useCan, useSession, useTimeZone } from "@/lib/session";
import { daysLeft } from "./closure-meta";

/**
 * L54 Akun Ditutup (backend doc 8.36): instead of the app while the account is closing. When the data goes,
 * what has stopped, where to withdraw OmniSeller at the marketplaces, the data export, and reopening.
 * Only who manages billing gets here; everyone else is refused at sign in.
 */
export function ClosingView() {
  const t = useTranslations("closure");
  const tCommon = useTranslations("common");
  const me = useSession();
  const can = useCan();
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const [reopening, setReopening] = useState(false);
  const closure = useQuery({
    queryKey: ["account-closure"],
    queryFn: () => unwrap(api.GET("/v1/account-closure")),
  });
  const reopen = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/account-closure")),
    onSuccess: () => {
      setReopening(false);
      toast.success(t("reopened"));
      // the session says the account is open again: the shell shows the app
      void queryClient.invalidateQueries();
    },
  });
  const logout = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/auth/logout")),
    onSettled: () => {
      queryClient.clear();
      leaveTo("/masuk");
    },
  });

  return (
    <main className="min-h-dvh bg-canvas">
      <div className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-8 md:py-12">
        {closure.isPending ? (
          <Skeleton className="h-64" />
        ) : closure.isError ? (
          <Card>
            <ErrorState error={closure.error} onRetry={() => closure.refetch()} />
          </Card>
        ) : (
          <Card className="border-danger/40">
            <CardHeader>
              <CardTitle>
                <h1 className="flex items-start gap-2 text-xl">
                  <CircleAlert aria-hidden className="mt-1 size-5 shrink-0 text-danger" />
                  {t("closingTitle", { name: me.tenant.name })}
                </h1>
              </CardTitle>
              <CardDescription className="text-[15px] text-text-700">
                {closure.data.purgeAfter
                  ? t("closingBody", {
                      date: formatDate(closure.data.purgeAfter, tz),
                      days: daysLeft(closure.data.purgeAfter),
                    })
                  : null}{" "}
                {closure.data.closingAt
                  ? closure.data.closedBy?.name
                    ? t("closedBy", {
                        name: closure.data.closedBy.name,
                        at: formatDateTime(closure.data.closingAt, tz),
                      })
                    : t("closedByUnknown", { at: formatDateTime(closure.data.closingAt, tz) })
                  : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <section className="grid gap-1.5" aria-labelledby="closing-meanwhile">
                <h2 id="closing-meanwhile" className="text-sm font-semibold text-text-900">
                  {t("meanwhile")}
                </h2>
                <ul className="grid list-disc gap-1 pl-5 text-sm text-text-700">
                  <li>{t("meanwhileStores")}</li>
                  <li>{t("meanwhileTeam")}</li>
                  <li>{t("meanwhilePlan")}</li>
                </ul>
              </section>
              {closure.data.revokeLinks.length > 0 ? (
                <section className="grid gap-1.5" aria-labelledby="closing-revoke">
                  <h2 id="closing-revoke" className="text-sm font-semibold text-text-900">
                    {t("revokeTitle")}
                  </h2>
                  <p className="text-sm text-text-700">{t("revokeBody")}</p>
                  <ul className="flex flex-wrap gap-2">
                    {closure.data.revokeLinks.map((l) => (
                      <li key={l.channel}>
                        <Button asChild variant="secondary" size="sm">
                          <a href={l.url} target="_blank" rel="noreferrer">
                            {t("revokeLink", { channel: channelLabel(l.channel) })}
                            <ExternalLink aria-hidden />
                          </a>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setReopening(true)}>{t("reopen")}</Button>
                <Button variant="secondary" loading={logout.isPending} onClick={() => logout.mutate()}>
                  <LogOut aria-hidden />
                  {t("logout")}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {can("data:export") ? (
          <DataExportView
            embedded
            note={
              closure.data?.purgeAfter ? t("exportNote", { date: formatDate(closure.data.purgeAfter, tz) }) : undefined
            }
          />
        ) : null}
      </div>

      <Dialog open={reopening} onOpenChange={setReopening}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("reopenTitle", { name: me.tenant.name })}</DialogTitle>
            <DialogDescription>{t("reopenBody")}</DialogDescription>
          </DialogHeader>
          {reopen.error ? (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(reopen.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setReopening(false)}>
              {tCommon("cancel")}
            </Button>
            <Button loading={reopen.isPending} onClick={() => reopen.mutate()}>
              {t("reopenConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
