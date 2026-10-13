"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ErrorState, PageHeader } from "@/components/common/page";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { useSession } from "@/lib/session";

type Preferences = components["schemas"]["PreferenceListDto_Output"];
const KEY = ["notification-preferences"];

/**
 * L44 Notifikasi (DOKUMEN-UI-UX 14.8, backend 8.20): each kind of notification by channel. In the app they
 * always arrive; email is the user's choice, except kinds that are always sent (a store losing its
 * connection). WhatsApp comes later. The choice is the user's own, for every business role.
 */
export function NotificationSettingsView() {
  const t = useTranslations("notificationSettings");
  const { plan } = useSession();
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: KEY, queryFn: () => unwrap(api.GET("/v1/notifications/preferences")) });
  const set = useMutation({
    mutationFn: ({ kind, email }: { kind: string; email: boolean }) =>
      unwrap(api.PUT("/v1/notifications/preferences/{kind}", { params: { path: { kind } }, body: { email } })),
    // the switch moves at once; a refusal puts it back
    onMutate: async ({ kind, email }) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const before = queryClient.getQueryData<Preferences>(KEY);
      queryClient.setQueryData<Preferences>(KEY, (p) =>
        p ? { items: p.items.map((i) => (i.kind === kind ? { ...i, email } : i)) } : p,
      );
      return { before };
    },
    onError: (e, _v, context) => {
      if (context?.before) queryClient.setQueryData(KEY, context.before);
      toast.error(errorMessage(e));
    },
    onSuccess: (_r, v) => toast.success(v.email ? t("emailOn") : t("emailOff")),
  });

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <Card className="gap-0 py-0">
        {prefs.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : prefs.isError ? (
          <ErrorState error={prefs.error} onRetry={() => prefs.refetch()} />
        ) : (
          <Table>
            <TableHeader className="bg-surface-2">
              <TableRow>
                <TableHead>{t("colKind")}</TableHead>
                <TableHead className="text-center">{t("colApp")}</TableHead>
                <TableHead className="text-center">{t("colEmail")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prefs.data.items.map((p) => {
                // a report the plan lacks: the row stays, locked, until the plan has it again
                const unavailable = p.feature !== null && !plan.features.includes(p.feature);
                return (
                  <TableRow key={p.kind}>
                    <TableCell className="whitespace-normal">
                      <div className="grid gap-0.5 whitespace-normal">
                        <span className="text-sm text-text-900">{p.label}</span>
                        {p.locked ? <span className="text-[13px] text-text-500">{t("lockedHint")}</span> : null}
                        {unavailable ? <span className="text-[13px] text-text-500">{t("lockedPlan")}</span> : null}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-center">
                      {p.inApp === "with_email" ? (
                        <span className="text-[13px] text-text-500">{t("appWithEmail")}</span>
                      ) : (
                        <>
                          <Check className="inline size-4 text-success" aria-hidden />
                          <span className="sr-only">{t("appAlways")}</span>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <span className="inline-flex items-center gap-2">
                        <Switch
                          checked={p.email}
                          disabled={p.locked || unavailable}
                          aria-label={t("emailFor", { kind: p.label })}
                          onCheckedChange={(email) => set.mutate({ kind: p.kind, email })}
                        />
                        {p.locked || unavailable ? <Lock className="size-3.5 text-text-500" aria-hidden /> : null}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      <p className="mt-3 text-[13px] text-text-500">{t("whatsappLater")}</p>
    </>
  );
}
