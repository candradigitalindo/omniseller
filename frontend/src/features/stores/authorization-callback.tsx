"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, CheckCircle2, Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { channelLabel } from "@/components/common/channel";
import { Button } from "@/components/ui/button";
import { AffiliateAccountCallback } from "@/features/affiliate-accounts/authorization-callback";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { type Authorization, callbackBody, isFinal } from "./store-meta";

const POLL_MS = 2_000;

/**
 * `/integrasi/callback/{channel}`: the marketplace sends the seller back here after the consent page. The
 * page hands its query to the api once, then follows the authorization until the worker has connected
 * the shops (backend 8.2, steps 2 to 5).
 */
export function AuthorizationCallback({ channel }: { channel: string }) {
  const params = useSearchParams();
  return (channel === "tiktokshop" || channel === "shopee") && params.get("state")?.startsWith("a1_") ? (
    <AffiliateAccountCallback channel={channel} />
  ) : (
    <SellerAuthorizationCallback channel={channel} />
  );
}

function SellerAuthorizationCallback({ channel }: { channel: string }) {
  const t = useTranslations("stores");
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const body = callbackBody(channel, params);
  const sent = useRef(false);

  const send = useMutation({
    mutationFn: (b: NonNullable<typeof body>) => unwrap(api.POST("/v1/store-authorizations/callback", { body: b })),
  });
  // the state is single-use: hand it over once, also under StrictMode's double effects
  useEffect(() => {
    if (!body || sent.current) return;
    sent.current = true;
    send.mutate(body);
  }, [body, send]);

  const id = send.data?.id;
  const poll = useQuery({
    queryKey: ["store-authorizations", id],
    queryFn: () => unwrap(api.GET("/v1/store-authorizations/{id}", { params: { path: { id: id ?? "" } } })),
    enabled: id !== undefined && !isFinal(send.data?.status ?? "pending"),
    refetchInterval: (q) => (q.state.data && isFinal(q.state.data.status) ? false : POLL_MS),
  });
  const current: Authorization | undefined = poll.data ?? send.data;
  const done = current && isFinal(current.status);

  useEffect(() => {
    if (current?.status !== "succeeded") return;
    void queryClient.invalidateQueries({ queryKey: ["stores"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }, [current?.status, queryClient]);

  const name = channelLabel(channel);
  if (!body) {
    return (
      <Outcome tone="danger" title={t("callbackInvalidTitle")} body={t("callbackInvalidBody")}>
        <BackToStores />
      </Outcome>
    );
  }
  if (send.isError) {
    return (
      <Outcome tone="danger" title={t("callbackFailedTitle", { channel: name })} body={errorMessage(send.error)}>
        <BackToStores />
      </Outcome>
    );
  }
  if (!current || !done) {
    return (
      <Outcome tone="busy" title={t("callbackWorking", { channel: name })} body={t("callbackWorkingBody")}>
        {poll.isError ? <p className="text-sm text-danger">{errorMessage(poll.error)}</p> : null}
      </Outcome>
    );
  }
  if (current.status !== "succeeded") {
    return (
      <Outcome
        tone="danger"
        title={t("callbackFailedTitle", { channel: name })}
        body={current.errorMessage ?? t("callbackFailedBody")}
      >
        <BackToStores />
      </Outcome>
    );
  }
  const { stores, skipped, failed } = current.result;
  return (
    <Outcome
      tone={stores.length > 0 ? "success" : "danger"}
      title={stores.length > 0 ? t("callbackDoneTitle", { count: stores.length }) : t("callbackNoneTitle")}
      body={stores.length > 0 ? t("callbackDoneBody") : undefined}
    >
      <ul className="grid gap-1.5 text-left text-sm">
        {stores.map((s) => (
          <li key={s.storeId} className="flex items-center gap-2 text-text-900">
            <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
            {s.reconnected ? t("shopReconnected", { name: s.name }) : t("shopConnected", { name: s.name })}
          </li>
        ))}
        {skipped.map((s) => (
          <li key={s.externalShopId} className="flex items-start gap-2 text-text-700">
            <AlertOctagon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            {t("shopSkipped", { shop: s.externalShopId, region: s.region ?? "?" })}
          </li>
        ))}
        {failed.map((s) => (
          <li key={s.externalShopId} className="flex items-start gap-2 text-text-700">
            <AlertOctagon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
            {s.reason === "shop_connected_elsewhere"
              ? t("shopElsewhere", { shop: s.externalShopId })
              : t("shopFailed", { shop: s.externalShopId, reason: s.reason })}
          </li>
        ))}
      </ul>
      <BackToStores primary />
    </Outcome>
  );
}

function Outcome({
  tone,
  title,
  body,
  children,
}: {
  tone: "busy" | "success" | "danger";
  title: string;
  body?: string | undefined;
  children?: React.ReactNode;
}) {
  const Icon = tone === "busy" ? Loader2 : tone === "success" ? CheckCircle2 : AlertOctagon;
  return (
    <div className="mx-auto grid max-w-lg justify-items-center gap-3 rounded-[10px] border bg-surface p-6 text-center shadow-card">
      <Icon
        className={
          tone === "busy"
            ? "size-10 animate-spin text-primary"
            : tone === "success"
              ? "size-10 text-success"
              : "size-10 text-danger"
        }
        aria-hidden
      />
      <h1 className="text-xl font-bold text-text-900" aria-live="polite">
        {title}
      </h1>
      {body ? <p className="text-text-500">{body}</p> : null}
      {children}
    </div>
  );
}

function BackToStores({ primary }: { primary?: boolean }) {
  const t = useTranslations("stores");
  return (
    <Button asChild variant={primary ? "default" : "secondary"} className="mt-2">
      <Link href="/integrasi">{t("backToStores")}</Link>
    </Button>
  );
}
