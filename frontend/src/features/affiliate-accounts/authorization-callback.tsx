"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, CheckCircle2, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";

const final = (status: string) => ["succeeded", "failed", "expired"].includes(status);
/** Uses the already registered marketplace callback URL; the state namespace selects the account flow. */
export function AffiliateAccountCallback() {
  const t = useTranslations("affiliateAccounts");
  const params = useSearchParams();
  const sent = useRef(false);
  const client = useQueryClient();
  const send = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/affiliate/authorizations/callback", {
          body: {
            state: params.get("state") ?? "",
            ...(params.get("code") ? { code: params.get("code")! } : {}),
            ...(params.get("error") ? { error: params.get("error")! } : {}),
          },
        }),
      ),
  });
  useEffect(() => {
    if (!sent.current) {
      sent.current = true;
      send.mutate();
    }
  }, [send]);
  const id = send.data?.id;
  const poll = useQuery({
    queryKey: ["affiliate-authorizations", id],
    queryFn: () => unwrap(api.GET("/v1/affiliate/authorizations/{id}", { params: { path: { id: id ?? "" } } })),
    enabled: !!id && !final(send.data?.status ?? "pending"),
    refetchInterval: (q) => (q.state.data && final(q.state.data.status) ? false : 2000),
  });
  const current = poll.data ?? send.data;
  const succeeded = current?.status === "succeeded";
  const failed = send.isError || (current && final(current.status) && !succeeded);
  useEffect(() => {
    if (succeeded) void client.invalidateQueries({ queryKey: ["affiliate-accounts"] });
  }, [succeeded, client]);
  const Icon = succeeded ? CheckCircle2 : failed ? AlertOctagon : LoaderCircle;
  return (
    <div className="mx-auto grid max-w-lg justify-items-center gap-4 rounded-2xl border bg-surface p-6 text-center shadow-card">
      <Icon
        className={`size-10 ${succeeded ? "text-success" : failed ? "text-danger" : "animate-spin text-primary"}`}
        aria-hidden
      />
      <h1 className="text-xl font-bold" aria-live="polite">
        {succeeded ? t("callbackSuccess") : failed ? t("callbackFailed") : t("callbackWorking")}
      </h1>
      <p className="text-text-500">
        {send.isError
          ? errorMessage(send.error)
          : failed
            ? (current?.errorMessage ?? t("callbackFailureHint"))
            : succeeded
              ? t("callbackSuccessHint")
              : t("callbackWorkingHint")}
      </p>
      {poll.isError ? (
        <div role="alert" className="grid gap-2 text-sm text-danger">
          <p>{errorMessage(poll.error)}</p>
          <Button variant="secondary" onClick={() => poll.refetch()}>
            {t("retryStatus")}
          </Button>
        </div>
      ) : null}
      <Button asChild variant={succeeded ? "default" : "secondary"}>
        <Link href="/affiliate/akun">{t("back")}</Link>
      </Button>
    </div>
  );
}
