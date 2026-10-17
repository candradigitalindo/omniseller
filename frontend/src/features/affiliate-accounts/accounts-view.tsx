"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, LoaderCircle, RefreshCw, Search, ShieldCheck, Unplug, UsersRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { formatDateTime } from "@/lib/format";
import { leaveTo } from "@/lib/navigate";
import { useCan, useTimeZone } from "@/lib/session";

type Account = components["schemas"]["AffiliateAccountDto_Output"];
type Kind = Account["kind"];
const queryKey = ["affiliate-accounts"];
const tone = (s: Account["status"]) =>
  s === "active" ? "success" : s === "verifying" ? "info" : s === "reauth_required" ? "warning" : "neutral";

export function AffiliateAccountsView() {
  const t = useTranslations("affiliateAccounts");
  const can = useCan();
  const mobile = useIsMobile();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [connect, setConnect] = useState(false);
  const [selected, setSelected] = useState<Account>();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [back, setBack] = useState<(string | undefined)[]>([]);
  const list = useQuery({
    queryKey: [...queryKey, search, cursor, mobile],
    queryFn: () =>
      unwrap(
        api.GET("/v1/affiliate/accounts", {
          params: { query: { q: search || undefined, cursor, limit: mobile ? 1 : 6 } },
        }),
      ),
    enabled: ready && can("affiliate:account_read"),
    refetchInterval: (q) => (q.state.data?.items.some((a) => a.status === "verifying") ? 3000 : false),
  });
  if (!can("affiliate:account_read")) return <PageHeader title={t("title")} description={t("noAccess")} />;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          can("affiliate:account_write") ? (
            <Button onClick={() => setConnect(true)}>
              <Link2 aria-hidden />
              {t("connect")}
            </Button>
          ) : undefined
        }
      />
      <form
        className="mb-4 flex max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(draft.trim());
          setCursor(undefined);
          setBack([]);
        }}
      >
        <Input
          aria-label={t("search")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("search")}
          maxLength={200}
        />
        <Button type="submit" variant="secondary" size="icon" aria-label={t("searchAction")}>
          <Search aria-hidden />
        </Button>
      </form>
      {list.isPending ? (
        <div role="status" aria-label={t("loading")}>
          <Skeleton className="h-40" />
          <p className="mt-2 text-sm text-text-500">{t("loading")}</p>
        </div>
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={UsersRound} title={t("empty")} body={t("emptyHint")} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.data.items.map((a) => (
              <Card key={a.id} className="gap-3 p-4">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-50 text-primary">
                    <UsersRound className="size-5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold">{a.name}</h2>
                    <p className="text-sm text-text-500">
                      {t(`channel.${a.channel ?? "tiktokshop"}`)} · {t(`kind.${a.kind}`)}
                    </p>
                    {a.regionVerified === false ? (
                      <p className="mt-1 text-xs text-warning">{t("regionUnverifiedShort")}</p>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <StatusPill tone={tone(a.status)}>{t(`status.${a.status}`)}</StatusPill>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={t("detailName", { name: a.name })}
                    onClick={() => setSelected(a)}
                  >
                    {t("detail")}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!back.length || list.isFetching}
              onClick={() => {
                setCursor(back.at(-1));
                setBack(back.slice(0, -1));
              }}
            >
              {t("previous")}
            </Button>
            <span className="text-sm text-text-500">{t("page", { count: back.length + 1 })}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={!list.data.next_cursor || list.isFetching}
              onClick={() => {
                setBack([...back, cursor]);
                setCursor(list.data.next_cursor ?? undefined);
              }}
            >
              {t("next")}
            </Button>
          </div>
        </>
      )}
      <ConnectDialog open={connect} onOpenChange={setConnect} />
      {selected ? <AccountDialog initial={selected} onClose={() => setSelected(undefined)} /> : null}
    </>
  );
}

function ConnectDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target?: Account;
}) {
  const t = useTranslations("affiliateAccounts");
  const [kind, setKind] = useState<Kind>(target?.kind ?? "creator");
  const [channel, setChannel] = useState<"tiktokshop" | "shopee">(target?.channel ?? "tiktokshop");
  const [program, setProgram] = useState<"video" | "live">(target?.program === "live" ? "live" : "video");
  const selectedChannel = target?.channel ?? channel;
  const start = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/affiliate/authorizations", {
          body: {
            channel: selectedChannel,
            program: selectedChannel === "shopee" ? program : "standard",
            kind: selectedChannel === "shopee" ? "creator" : (target?.kind ?? kind),
            ...(target ? { accountId: target.id } : {}),
          },
        }),
      ),
    onSuccess: (result) => leaveTo(result.authorizeUrl),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!start.isPending) onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target ? t("reconnect") : t("connectTitle")}</DialogTitle>
          <DialogDescription>
            {t(selectedChannel === "shopee" ? "shopeeRequirements" : "requirements")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate();
          }}
        >
          <div className="grid gap-2">
            <label htmlFor="account-channel" className="font-medium">
              {t("channelLabel")}
            </label>
            <Select
              value={selectedChannel}
              onValueChange={(v) => setChannel(v as "tiktokshop" | "shopee")}
              disabled={!!target || start.isPending}
            >
              <SelectTrigger id="account-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tiktokshop">{t("channel.tiktokshop")}</SelectItem>
                <SelectItem value="shopee">{t("channel.shopee")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {selectedChannel === "shopee" ? (
            <div className="grid gap-2">
              <label htmlFor="account-program" className="font-medium">
                {t("programLabel")}
              </label>
              <Select
                value={program}
                onValueChange={(v) => setProgram(v as "video" | "live")}
                disabled={start.isPending}
              >
                <SelectTrigger id="account-program">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="video">{t("program.video")}</SelectItem>
                  <SelectItem value="live">{t("program.live")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="rounded-xl bg-warning-soft p-3 text-sm">{t("shopeeRegionHint")}</p>
            </div>
          ) : (
            <div className="grid gap-2">
              <label htmlFor="account-kind" className="font-medium">
                {t("kindLabel")}
              </label>
              <Select
                value={target?.kind ?? kind}
                onValueChange={(v) => setKind(v as Kind)}
                disabled={!!target || start.isPending}
              >
                <SelectTrigger id="account-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="creator">{t("kind.creator")}</SelectItem>
                  <SelectItem value="affiliate_partner">{t("kind.affiliate_partner")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex gap-2 rounded-xl bg-primary-50 p-3 text-sm">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <p>{t("consentHint")}</p>
          </div>
          {start.isError ? (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(start.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={start.isPending}>
              {start.isPending ? <LoaderCircle className="animate-spin" aria-hidden /> : <Link2 aria-hidden />}
              {start.isPending ? t("opening") : t("continue")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccountDialog({ initial, onClose }: { initial: Account; onClose: () => void }) {
  const t = useTranslations("affiliateAccounts");
  const zone = useTimeZone();
  const can = useCan();
  const client = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [reconnect, setReconnect] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [scopePage, setScopePage] = useState(0);
  const [categoryPage, setCategoryPage] = useState(0);
  const [watch, setWatch] = useState<{ version: number; until: number }>();
  const [scopeSearch, setScopeSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(() => crypto.randomUUID());
  const detail = useQuery({
    queryKey: [...queryKey, initial.id],
    queryFn: () => unwrap(api.GET("/v1/affiliate/accounts/{id}", { params: { path: { id: initial.id } } })),
    initialData: initial,
    refetchInterval: (q) =>
      q.state.data?.status === "verifying" ||
      (watch && Date.now() < watch.until && (q.state.data?.rowVersion ?? 0) <= watch.version)
        ? 3000
        : false,
  });
  const a = detail.data;
  const invalidate = () => client.invalidateQueries({ queryKey });
  const rename = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/v1/affiliate/accounts/{id}", {
          params: { path: { id: a.id }, header: { "If-Match": String(a.rowVersion) } },
          body: { name: name.trim() },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      toast.success(t("saved"));
    },
  });
  const refresh = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/affiliate/accounts/{id}/refresh", {
          params: { path: { id: a.id }, header: { "Idempotency-Key": refreshKey } },
        }),
      ),
    onSuccess: async () => {
      setRefreshKey(crypto.randomUUID());
      setWatch({ version: a.rowVersion, until: Date.now() + 120_000 });
      await invalidate();
      toast.success(t("refreshQueued"));
    },
  });
  const disconnect = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/affiliate/accounts/{id}/disconnect", { params: { path: { id: a.id } } })),
    onSuccess: async () => {
      await invalidate();
      onClose();
      toast.success(t("disconnected"));
    },
  });
  const scopes = a.scopes.filter((s) => s.toLowerCase().includes(scopeSearch.toLowerCase()));
  const categories = Array.isArray(a.profile.categories)
    ? a.profile.categories.filter(
        (v): v is { id: string; name: string; market: string } =>
          typeof v === "object" &&
          v !== null &&
          "id" in v &&
          typeof v.id === "string" &&
          "name" in v &&
          typeof v.name === "string" &&
          "market" in v &&
          typeof v.market === "string",
      )
    : [];
  return (
    <>
      <Dialog
        open
        onOpenChange={(v) => {
          if (!v && !disconnect.isPending && !rename.isPending) onClose();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("detailTitle")}</DialogTitle>
            <DialogDescription className="break-words">{a.name}</DialogDescription>
          </DialogHeader>
          <StatusPill tone={tone(a.status)}>{t(`status.${a.status}`)}</StatusPill>
          <Tabs defaultValue="profile">
            <TabsList className={`grid w-full ${a.kind === "affiliate_partner" ? "grid-cols-4" : "grid-cols-3"}`}>
              <TabsTrigger value="profile">{t("profileTab")}</TabsTrigger>
              <TabsTrigger value="access">{t("accessTab")}</TabsTrigger>
              {a.kind === "affiliate_partner" ? (
                <TabsTrigger value="categories">{t("categoriesTab")}</TabsTrigger>
              ) : null}
              <TabsTrigger value="manage">{t("manageTab")}</TabsTrigger>
            </TabsList>
            <TabsContent value="profile" className="grid gap-3">
              <dl className="grid gap-3 text-sm">
                <div>
                  <dt className="text-text-500">{t("kindLabel")}</dt>
                  <dd>{t(`kind.${a.kind}`)}</dd>
                </div>
                <div>
                  <dt className="text-text-500">{t("principalId")}</dt>
                  <dd className="break-all font-mono">{a.externalPrincipalId}</dd>
                </div>
                <div>
                  <dt className="text-text-500">{t("region")}</dt>
                  <dd>{t(a.regionVerified === false ? "indonesiaUnverified" : "indonesia")}</dd>
                </div>
                <div>
                  <dt className="text-text-500">{t("channelLabel")}</dt>
                  <dd>{t(`channel.${a.channel ?? "tiktokshop"}`)}</dd>
                </div>
                <div>
                  <dt className="text-text-500">{t("connectedAt")}</dt>
                  <dd>{formatDateTime(a.connectedAt, zone)}</dd>
                </div>
              </dl>
              {a.regionVerified === false ? (
                <p className="rounded-xl bg-warning-soft p-3 text-sm">{t("shopeeRegionHint")}</p>
              ) : null}
              {a.errorMessage ? (
                <p role="alert" className="rounded-xl bg-warning-soft p-3 text-sm">
                  {a.errorMessage}
                </p>
              ) : null}
              {detail.isError ? (
                <p role="alert" className="text-danger">
                  {errorMessage(detail.error)}
                </p>
              ) : null}
            </TabsContent>
            <TabsContent value="access" className="grid gap-3 text-sm">
              <p>{t(a.channel === "shopee" ? "shopeeScopeHint" : "scopeHint")}</p>
              <Input
                aria-label={t("searchScopes")}
                placeholder={t("searchScopes")}
                value={scopeSearch}
                onChange={(e) => {
                  setScopeSearch(e.target.value);
                  setScopePage(0);
                }}
              />
              <ul className="grid gap-1" aria-label={t("scopes")}>
                {scopes.slice(scopePage * 4, (scopePage + 1) * 4).map((scope) => (
                  <li className="break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs" key={scope}>
                    {scope}
                  </li>
                ))}
              </ul>
              {scopes.length > 4 ? (
                <div className="flex justify-between">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={scopePage === 0}
                    onClick={() => setScopePage(scopePage - 1)}
                  >
                    {t("previous")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={(scopePage + 1) * 4 >= scopes.length}
                    onClick={() => setScopePage(scopePage + 1)}
                  >
                    {t("next")}
                  </Button>
                </div>
              ) : null}
              {a.kind === "affiliate_partner" ? <p>{t("categoryCount", { count: categories.length })}</p> : null}
              <p className="text-text-500">
                {t("authorizationExpires")}{" "}
                {a.authorizationExpiresAt ? formatDateTime(a.authorizationExpiresAt, zone) : t("unknown")}
              </p>
            </TabsContent>
            {a.kind === "affiliate_partner" ? (
              <TabsContent value="categories" className="grid gap-3 text-sm">
                <p>{t("categoryHint")}</p>
                <p>{t("categoryCount", { count: categories.length })}</p>
                <ul className="grid gap-2" aria-label={t("categoriesTab")}>
                  {categories.slice(categoryPage * 3, (categoryPage + 1) * 3).map((c) => (
                    <li key={c.id} className="rounded-lg bg-surface-2 p-3">
                      <p className="break-words font-medium">{c.name}</p>
                      <p className="break-all font-mono text-xs text-text-500">{c.id}</p>
                    </li>
                  ))}
                </ul>
                {categories.length > 3 ? (
                  <div className="flex justify-between">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={categoryPage === 0}
                      onClick={() => setCategoryPage(categoryPage - 1)}
                    >
                      {t("previous")}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={(categoryPage + 1) * 3 >= categories.length}
                      onClick={() => setCategoryPage(categoryPage + 1)}
                    >
                      {t("next")}
                    </Button>
                  </div>
                ) : null}
              </TabsContent>
            ) : null}
            <TabsContent value="manage" className="grid gap-4">
              {can("affiliate:account_write") ? (
                <>
                  <form
                    className="grid gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      rename.mutate();
                    }}
                  >
                    <label htmlFor="account-name">{t("localName")}</label>
                    <Input id="account-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
                    <Button type="submit" variant="secondary" disabled={rename.isPending || !name.trim()}>
                      {rename.isPending ? t("saving") : t("save")}
                    </Button>
                    {rename.isError ? (
                      <p role="alert" className="text-danger">
                        {errorMessage(rename.error)}
                      </p>
                    ) : null}
                  </form>
                  {a.status === "active" || a.status === "verifying" ? (
                    <Button variant="secondary" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
                      <RefreshCw className={refresh.isPending ? "animate-spin" : ""} aria-hidden />
                      {refresh.isPending ? t("refreshing") : t("refresh")}
                    </Button>
                  ) : (
                    <Button onClick={() => setReconnect(true)}>
                      <Link2 aria-hidden />
                      {t("reconnect")}
                    </Button>
                  )}
                  {watch && Date.now() < watch.until && a.rowVersion <= watch.version ? (
                    <p role="status" className="flex items-center gap-2 text-sm text-primary">
                      <LoaderCircle className="size-4 animate-spin" aria-hidden />
                      {t("watching")}
                    </p>
                  ) : null}
                  {refresh.isError ? (
                    <p role="alert" className="text-danger">
                      {errorMessage(refresh.error)}
                    </p>
                  ) : null}
                  {a.status !== "disconnected" ? (
                    <Button variant="destructive" onClick={() => setConfirm(true)}>
                      <Unplug aria-hidden />
                      {t("disconnect")}
                    </Button>
                  ) : null}
                </>
              ) : (
                <p className="text-text-500">{t("readOnly")}</p>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      <ConnectDialog open={reconnect} onOpenChange={setReconnect} target={a} />
      <Dialog
        open={confirm}
        onOpenChange={(v) => {
          if (!disconnect.isPending) setConfirm(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("disconnectTitle")}</DialogTitle>
            <DialogDescription>{t("disconnectHint")}</DialogDescription>
          </DialogHeader>
          {disconnect.isError ? (
            <p role="alert" className="text-danger">
              {errorMessage(disconnect.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" disabled={disconnect.isPending} onClick={() => setConfirm(false)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              {disconnect.isPending ? t("disconnecting") : t("disconnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
