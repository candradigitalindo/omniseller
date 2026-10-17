"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, ArrowRight, CheckCircle2, Loader2, Store } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatDateTime } from "@/lib/format";
import { useCan, useSession, useTimeZone } from "@/lib/session";
import { isFinal } from "./store-meta";

/** The receipt proves only a browser handoff. No shop identity is claimed before the worker verifies it. */
export function AppStoreInstallation() {
  const t = useTranslations("storeInstallation");
  const can = useCan();
  const me = useSession();
  const timeZone = useTimeZone();
  const params = useSearchParams();
  const [confirmed, setConfirmed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedShops, setSelectedShops] = useState<string[]>([]);
  const [shopSearch, setShopSearch] = useState("");
  const [shopPage, setShopPage] = useState(0);
  const [outcomePage, setOutcomePage] = useState(0);
  const queryClient = useQueryClient();
  const allowed = can("settings:store");
  const captureFailed = params.get("capture") === "failed";
  const challenge = useQuery({
    queryKey: ["store-installation", me.tenant.id, me.user.id],
    queryFn: () => unwrap(api.GET("/v1/store-installations/tiktokshop")),
    enabled: allowed && !captureFailed,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const connect = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/store-installations/tiktokshop/confirm", {
          body: { confirmationToken: challenge.data!.confirmationToken, confirmed: true },
        }),
      ),
    onSuccess: () => setReviewing(false),
  });
  const id = connect.data?.id;
  const status = useQuery({
    queryKey: ["store-authorizations", id],
    queryFn: () => unwrap(api.GET("/v1/store-authorizations/{id}", { params: { path: { id: id! } } })),
    enabled: !!id && !isFinal(connect.data!.status),
    refetchInterval: (query) =>
      query.state.data && (isFinal(query.state.data.status) || query.state.data.installation?.awaitingShopSelection)
        ? false
        : 2_000,
    retry: false,
  });
  const current = status.data ?? connect.data;
  const awaitingSelection = current?.installation?.awaitingShopSelection === true;
  const selection = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/store-installations/tiktokshop/select-shops", {
          body: {
            authorizationId: id!,
            confirmationToken: challenge.data!.confirmationToken,
            confirmed: true,
            shopIds: selectedShops,
          },
        }),
      ),
    onSuccess: (value) => {
      setSelecting(false);
      queryClient.setQueryData(["store-authorizations", id], value);
      void queryClient.invalidateQueries({ queryKey: ["store-authorizations", id] });
    },
  });
  const shops =
    current?.installation?.shops.filter((shop) =>
      `${shop.name} ${shop.externalShopId}`.toLowerCase().includes(shopSearch.toLowerCase()),
    ) ?? [];
  const shopPages = Math.max(1, Math.ceil(shops.length / 2));
  const visibleShops = shops.slice(Math.min(shopPage, shopPages - 1) * 2, (Math.min(shopPage, shopPages - 1) + 1) * 2);
  const working =
    connect.isPending || selection.isPending || (!!current && !isFinal(current.status) && !awaitingSelection);
  const successful = current?.status === "succeeded" && current.result.stores.length > 0;
  const partial = successful && current.result.failed.length > 0;
  const outcomeName = (externalId: string) =>
    current?.installation?.shops.find((shop) => shop.externalShopId === externalId)?.name ??
    t("unnamedShop", { id: externalId });
  const outcomes = [
    ...(current?.result.stores.map((shop) => ({
      id: shop.externalShopId,
      name: shop.name,
      tone: "success" as const,
      detail: shop.reconnected ? t("reconnected") : t("connected"),
    })) ?? []),
    ...(current?.result.failed.map((shop) => ({
      id: shop.externalShopId,
      name: outcomeName(shop.externalShopId),
      tone: "danger" as const,
      detail:
        shop.reason === "billing_limit_reached"
          ? t("quotaReached")
          : shop.reason === "shop_connected_elsewhere"
            ? t("connectedElsewhere")
            : shop.reason === "permission_revoked"
              ? t("permissionChanged")
              : t("connectionFailed"),
    })) ?? []),
    ...(current?.result.skipped.map((shop) => ({
      id: shop.externalShopId,
      name: outcomeName(shop.externalShopId),
      tone: "warning" as const,
      detail: t("unsupportedRegion", { region: shop.region ?? "?" }),
    })) ?? []),
  ];
  const outcomePages = Math.max(1, Math.ceil(outcomes.length / 3));
  const currentOutcomePage = Math.min(outcomePage, outcomePages - 1);
  const visibleOutcomes = outcomes.slice(currentOutcomePage * 3, (currentOutcomePage + 1) * 3);
  const failure = captureFailed
    ? t("captureFailed")
    : !allowed
      ? t("permissionRequired")
      : challenge.error
        ? errorMessage(challenge.error)
        : connect.error
          ? errorMessage(connect.error)
          : current && isFinal(current.status) && !successful
            ? (current.errorMessage ?? t("connectionFailed"))
            : null;
  const Icon = partial ? AlertOctagon : successful ? CheckCircle2 : failure ? AlertOctagon : working ? Loader2 : Store;

  return (
    <section className="mx-auto grid w-full max-w-lg gap-3 rounded-2xl border bg-surface p-4 shadow-card sm:gap-5 sm:p-7">
      <div className="grid justify-items-center gap-3 text-center">
        <div
          className={`rounded-2xl bg-primary-soft p-3 ${!working && !successful && !failure ? "hidden sm:block" : ""}`}
        >
          <Icon
            className={`size-7 ${working ? "animate-spin" : ""} ${failure ? "text-danger" : partial ? "text-warning" : successful ? "text-success" : "text-primary"}`}
            aria-hidden
          />
        </div>
        <h1 className="text-xl font-bold text-text-900" aria-live="polite">
          {partial
            ? t("partialTitle")
            : successful
              ? t("doneTitle")
              : awaitingSelection
                ? t("verifiedTitle")
                : working
                  ? t("workingTitle")
                  : t("title")}
        </h1>
        <p className={`text-sm text-text-500 ${!working && !successful && !failure ? "hidden sm:block" : ""}`}>
          {partial
            ? t("partialBody", { connected: current.result.stores.length, failed: current.result.failed.length })
            : successful
              ? t("doneBody")
              : awaitingSelection
                ? t("verifiedBody")
                : working
                  ? t("workingBody")
                  : t("description")}
        </p>
      </div>
      {failure ? (
        <p role="alert" className="rounded-xl border border-danger/20 bg-danger/5 p-3 text-sm text-danger">
          {failure}
        </p>
      ) : null}
      {partial ? (
        <p role="status" className="rounded-xl border border-warning/20 bg-warning/5 p-3 text-sm text-text-700">
          {t("partialWarning", { count: current.result.failed.length })}
          {current.result.failed.every((shop) => shop.reason === "billing_limit_reached")
            ? ` ${t("quotaReached")}`
            : ""}
        </p>
      ) : null}
      {connect.isError && challenge.data && confirmed && !reviewing ? (
        <Button loading={connect.isPending} loadingLabel={t("submitting")} onClick={() => connect.mutate()}>
          {t("retry")}
        </Button>
      ) : null}
      {challenge.isPending && allowed && !captureFailed ? (
        <p className="text-center text-sm text-text-500" role="status">
          {t("checking")}
        </p>
      ) : null}
      {awaitingSelection ? (
        <>
          <p className="text-center text-sm text-text-700">
            {t("business")}: <strong>{me.tenant.name}</strong>
          </p>
          <Button onClick={() => setSelecting(true)}>{t("reviewShops")}</Button>
        </>
      ) : null}
      {!failure && challenge.data && !current ? (
        <>
          <dl className="grid gap-3 rounded-xl bg-canvas p-3 text-sm sm:p-4">
            <div className="grid gap-1">
              <dt className="text-text-500">{t("business")}</dt>
              <dd className="line-clamp-2 break-words font-semibold text-text-900">{me.tenant.name}</dd>
            </div>
          </dl>
          <Button onClick={() => setReviewing(true)}>
            {t("review")}
            <ArrowRight className="size-4" aria-hidden />
          </Button>
          <Link
            href="/masuk?next=%2Fintegrasi%2Finstalasi%2Ftiktokshop"
            className="text-center text-sm font-medium text-primary hover:underline"
          >
            {t("differentBusiness")}
          </Link>
        </>
      ) : null}
      {current && isFinal(current.status) && outcomes.length > 0 ? (
        <>
          <ul className="grid gap-2 text-sm text-text-900">
            {visibleOutcomes.map((shop) => (
              <li key={`${shop.tone}-${shop.id}`} className="flex min-w-0 items-start gap-2">
                {shop.tone === "success" ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                ) : (
                  <AlertOctagon
                    className={`mt-0.5 size-4 shrink-0 ${shop.tone === "danger" ? "text-danger" : "text-warning"}`}
                    aria-hidden
                  />
                )}
                <div className="grid min-w-0 gap-0.5">
                  <span className="break-words">{shop.name}</span>
                  <span className="text-xs text-text-500">{shop.detail}</span>
                </div>
              </li>
            ))}
          </ul>
          {outcomePages > 1 ? (
            <nav aria-label={t("outcomePages")} className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={currentOutcomePage === 0}
                onClick={() => setOutcomePage((value) => value - 1)}
              >
                {t("previous")}
              </Button>
              <span className="text-xs text-text-500" aria-live="polite">
                {t("page", { page: currentOutcomePage + 1, total: outcomePages })}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={currentOutcomePage >= outcomePages - 1}
                onClick={() => setOutcomePage((value) => value + 1)}
              >
                {t("next")}
              </Button>
            </nav>
          ) : null}
        </>
      ) : null}
      {status.error ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(status.error)}
        </p>
      ) : null}
      <Button variant="secondary" asChild>
        <Link href="/integrasi">{t("back")}</Link>
      </Button>
      <Dialog open={reviewing} onOpenChange={(value) => !connect.isPending && setReviewing(value)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("reviewTitle")}</DialogTitle>
            <DialogDescription>{t("reviewBody", { business: me.tenant.name, user: me.user.name })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <p className="rounded-xl border border-warning/20 bg-warning/5 p-3 text-sm text-text-700">
              {t("unverified")}
            </p>
            {challenge.data ? (
              <p className="text-xs text-text-500">
                {t("expiresAt")}: {formatDateTime(challenge.data.expiresAt, timeZone)}
              </p>
            ) : null}
            <div className="flex items-start gap-3">
              <Checkbox
                id="confirm-installation"
                checked={confirmed}
                onCheckedChange={(v) => setConfirmed(v === true)}
                disabled={connect.isPending}
                className="mt-0.5"
              />
              <Label htmlFor="confirm-installation" className="text-sm font-normal leading-relaxed">
                {t("confirmConsent", { business: me.tenant.name })}
              </Label>
            </div>
            {connect.error ? (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(connect.error)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setReviewing(false)} disabled={connect.isPending}>
              {t("cancel")}
            </Button>
            <Button
              disabled={!confirmed || !challenge.data}
              loading={connect.isPending}
              loadingLabel={t("submitting")}
              onClick={() => connect.mutate()}
            >
              {t("connect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={selecting} onOpenChange={(value) => !selection.isPending && setSelecting(value)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("selectTitle")}</DialogTitle>
            <DialogDescription>{t("selectBody", { business: me.tenant.name })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Label htmlFor="search-verified-shop" className="sr-only">
              {t("searchShops")}
            </Label>
            <Input
              id="search-verified-shop"
              type="search"
              value={shopSearch}
              onChange={(event) => {
                setShopSearch(event.target.value);
                setShopPage(0);
              }}
              placeholder={t("searchShops")}
            />
            {visibleShops.map((shop) => (
              <div key={shop.externalShopId} className="flex items-start gap-3 rounded-xl border p-3">
                <Checkbox
                  id={`verified-shop-${shop.externalShopId}`}
                  checked={selectedShops.includes(shop.externalShopId)}
                  disabled={selection.isPending}
                  className="mt-1"
                  onCheckedChange={(checked) =>
                    setSelectedShops((values) =>
                      checked ? [...values, shop.externalShopId] : values.filter((id) => id !== shop.externalShopId),
                    )
                  }
                />
                <Label htmlFor={`verified-shop-${shop.externalShopId}`} className="grid min-w-0 gap-1 leading-relaxed">
                  <span className="break-words">{shop.name}</span>
                  <span className="break-all text-xs font-normal text-text-500">
                    {t("shopIdentity", { id: shop.externalShopId })}
                  </span>
                </Label>
              </div>
            ))}
            {shops.length === 0 ? <p className="text-sm text-text-500">{t("noShops")}</p> : null}
            {shopPages > 1 ? (
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={shopPage === 0}
                  onClick={() => setShopPage((value) => value - 1)}
                >
                  {t("previous")}
                </Button>
                <span className="text-xs text-text-500">{t("page", { page: shopPage + 1, total: shopPages })}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={shopPage >= shopPages - 1}
                  onClick={() => setShopPage((value) => value + 1)}
                >
                  {t("next")}
                </Button>
              </div>
            ) : null}
            <p className="rounded-xl bg-warning/5 p-3 text-sm text-text-700">{t("verifyOwnership")}</p>
            {selection.error ? (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(selection.error)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" disabled={selection.isPending} onClick={() => setSelecting(false)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={!selectedShops.length}
              loading={selection.isPending}
              loadingLabel={t("binding")}
              onClick={() => selection.mutate()}
            >
              {t("bindSelected", { count: selectedShops.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
