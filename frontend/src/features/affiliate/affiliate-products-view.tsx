"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, RefreshCw, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
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
import { usableStore } from "@/features/stores/store-meta";
import { useIsMobile } from "@/hooks/use-mobile";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";

type Result = components["schemas"]["AffiliateProductsDto_Output"];
type Query = components["schemas"]["RequestAffiliateProductsDto"];
type Product = Result["items"][number];
const rate = (bps: number) => `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(bps / 100)}%`;

export function AffiliateProductsView() {
  const t = useTranslations("affiliate");
  const can = useCan();
  const [chosen, setChosen] = useState("");
  const stores = useQuery({
    queryKey: ["stores"],
    queryFn: () => unwrap(api.GET("/v1/stores")),
    enabled: can("affiliate:read"),
  });
  const eligible =
    stores.data?.items.filter((s) => s.channel === "shopee" && s.region === "ID" && usableStore(s.status)) ?? [];
  const storeId = eligible.some((s) => s.id === chosen) ? chosen : eligible[0]?.id;
  if (!can("affiliate:read")) return <PageHeader title={t("title")} description={t("noAccess")} />;
  return (
    <>
      <PageHeader title={t("title")} description={t("subtitle")} />
      {stores.isPending ? (
        <Skeleton className="h-32" />
      ) : stores.isError ? (
        <ErrorState error={stores.error} onRetry={() => stores.refetch()} />
      ) : eligible.length === 0 ? (
        <EmptyState title={t("noStore")} body={t("noStoreHint")} />
      ) : (
        <>
          <div className="mb-4 grid max-w-md gap-2">
            <label htmlFor="affiliate-store" className="text-sm font-medium">
              {t("store")}
            </label>
            <Select value={storeId} onValueChange={setChosen}>
              <SelectTrigger id="affiliate-store">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {storeId ? <ShopProducts key={storeId} storeId={storeId} /> : null}
        </>
      )}
    </>
  );
}
function ShopProducts({ storeId }: { storeId: string }) {
  const t = useTranslations("affiliate");
  const zone = useTimeZone();
  const mobile = useIsMobile();
  const client = useQueryClient();
  const [requestId, setRequestId] = useState<string>();
  const [back, setBack] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [detail, setDetail] = useState<Product | null>(null);
  const [search, setSearch] = useState("");
  const [by, setBy] = useState<"name" | "id">("name");
  const [sort, setSort] = useState<"commission_rate" | "-commission_rate">("-commission_rate");
  const retryKey = useRef<{ hash: string; key: string } | null>(null);
  const result = useQuery({
    queryKey: ["affiliate", storeId, requestId],
    queryFn: () =>
      unwrap(
        api.GET("/v1/stores/{id}/affiliate/products", {
          params: { path: { id: storeId }, query: requestId ? { requestId } : {} },
        }),
      ),
    refetchInterval: (q) =>
      q.state.data?.request && ["queued", "running"].includes(q.state.data.request.status) ? 2000 : false,
  });
  const row = result.data?.request;
  const pending = !!row && ["queued", "running"].includes(row.status);
  const read = useMutation({
    mutationFn: async (query: Query) => {
      const hash = JSON.stringify(query);
      if (retryKey.current?.hash !== hash) retryKey.current = { hash, key: crypto.randomUUID() };
      return unwrap(
        api.POST("/v1/stores/{id}/affiliate/products", {
          params: { path: { id: storeId }, header: { "Idempotency-Key": retryKey.current.key } },
          body: query,
        }),
      );
    },
    onSuccess: (next, query) => {
      retryKey.current = null;
      setBack((old) => (query.cursor && row ? [...old, row.id] : []));
      client.setQueryData(["affiliate", storeId, next.id], { request: next });
      setRequestId(next.id);
      setFilterOpen(false);
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      void result.refetch();
    },
  });
  const busy = pending || read.isPending;
  const newQuery = (): Query => ({
    pageSize: mobile ? 3 : 8,
    sortBy: sort,
    ...(search.trim() ? { search: { by, value: search.trim() } } : {}),
  });
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-500">{t("requirement")}</p>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => setFilterOpen(true)}>
            <Search aria-hidden />
            {t("search")}
          </Button>
          {row ? (
            <Button
              variant="ghost"
              aria-label={t("refresh")}
              disabled={busy}
              onClick={() => read.mutate({ ...row.query, cursor: undefined })}
            >
              <RefreshCw aria-hidden />
              {t("refresh")}
            </Button>
          ) : null}
        </div>
      </div>
      {result.isPending ? (
        <Skeleton className="h-48" />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => result.refetch()} />
      ) : !row ? (
        <EmptyState title={t("emptyStart")} body={t("emptyStartHint")} />
      ) : (
        <>
          <div role="status" className="mb-3 rounded-xl border bg-surface p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusPill
                tone={row.status === "succeeded" ? "success" : row.status === "failed" ? "danger" : "info"}
                icon={pending ? LoaderCircle : undefined}
              >
                {t(`request_${row.status}`)}
              </StatusPill>
              <span className="text-xs text-text-500">{formatDateTime(row.finishedAt ?? row.createdAt, zone)}</span>
            </div>
            {pending ? <p className="mt-2 text-text-500">{t("progress")}</p> : null}
            {row.errorMessage ? <p className="mt-2">{row.errorMessage}</p> : null}
            {row.status === "succeeded" ? (
              <p className="mt-2 text-text-500">
                {t("resultCount", { shown: row.items.length, total: formatNumber(row.total ?? 0) })}
                {row.query.search ? ` · ${row.query.search.value}` : ""}
              </p>
            ) : null}
            {row.status === "failed" ? (
              <Button
                className="mt-2"
                size="sm"
                variant="secondary"
                loading={read.isPending}
                onClick={() => read.mutate(row.query)}
              >
                {t("retry")}
              </Button>
            ) : null}
          </div>
          {row.status === "succeeded" ? (
            row.items.length === 0 ? (
              <EmptyState title={t("empty")} body={t("emptyHint")} />
            ) : (
              <Card className="divide-y overflow-hidden">
                {row.items.map((p) => (
                  <div key={`${p.externalItemId}-${p.externalCampaignId}`} className="flex items-center gap-3 p-3">
                    <div className="grid min-w-0 flex-1 gap-1">
                      <span className="line-clamp-2 text-sm font-medium">{p.title}</span>
                      <span className="truncate text-xs text-text-500">
                        {t("productId")} {p.externalItemId}
                      </span>
                    </div>
                    <div className="grid shrink-0 justify-items-end gap-1">
                      <strong className="text-sm text-primary">{rate(p.commissionBasisPoints)}</strong>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`${t("detail")} ${p.title}`}
                        onClick={() => setDetail(p)}
                      >
                        {t("detail")}
                      </Button>
                    </div>
                  </div>
                ))}
              </Card>
            )
          ) : null}
          {row.status === "succeeded" ? (
            <div className="mt-3 flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!back.length || busy}
                onClick={() => {
                  setRequestId(back.at(-1));
                  setBack(back.slice(0, -1));
                }}
              >
                {t("previous")}
              </Button>
              <span className="min-w-0 text-center text-sm text-text-500">
                {t("page", { number: back.length + 1 })}
              </span>
              <Button
                size="sm"
                variant="secondary"
                loading={read.isPending}
                disabled={!row.nextCursor || busy}
                onClick={() => read.mutate({ ...row.query, cursor: row.nextCursor })}
              >
                {t("next")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <Dialog open={filterOpen} onOpenChange={setFilterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("searchTitle")}</DialogTitle>
            <DialogDescription>{t("searchHint")}</DialogDescription>
          </DialogHeader>
          <form
            id="affiliate-search"
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) read.mutate(newQuery());
            }}
          >
            <label htmlFor="affiliate-search-by" className="grid gap-1 text-sm">
              {t("searchBy")}
              <Select value={by} onValueChange={(v) => setBy(v as "name" | "id")}>
                <SelectTrigger id="affiliate-search-by" aria-label={t("searchBy")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name">{t("byName")}</SelectItem>
                  <SelectItem value="id">{t("byId")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label htmlFor="affiliate-search-keyword" className="grid gap-1 text-sm">
              {t("keyword")}
              <Input
                id="affiliate-search-keyword"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                maxLength={by === "id" ? 2000 : 200}
                placeholder={t("keywordHint")}
              />
            </label>
            <label htmlFor="affiliate-search-sort" className="grid gap-1 text-sm">
              {t("sort")}
              <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
                <SelectTrigger id="affiliate-search-sort" aria-label={t("sort")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="-commission_rate">{t("highest")}</SelectItem>
                  <SelectItem value="commission_rate">{t("lowest")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </form>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setFilterOpen(false)}>
              {t("close")}
            </Button>
            <Button type="submit" form="affiliate-search" loading={read.isPending} disabled={busy}>
              {t("show")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {detail ? <ProductDetail product={detail} onClose={() => setDetail(null)} /> : null}
    </>
  );
}
function ProductDetail({ product: p, onClose }: { product: Product; onClose: () => void }) {
  const t = useTranslations("affiliate");
  const zone = useTimeZone();
  const [page, setPage] = useState(0);
  const protection = p.protections[page];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("detailTitle")}</DialogTitle>
          <DialogDescription className="line-clamp-2">{p.title}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="overview">
          <TabsList className="grid w-full grid-cols-2" aria-label={t("detailTitle")}>
            <TabsTrigger value="overview">{t("overviewTab")}</TabsTrigger>
            <TabsTrigger value="period">{t("periodTab")}</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-text-500">{t("productId")}</dt>
              <dd className="break-all">{p.externalItemId}</dd>
              <dt className="text-text-500">{t("campaignId")}</dt>
              <dd>{p.externalCampaignId}</dd>
              <dt className="text-text-500">{t("campaignStatus")}</dt>
              <dd>
                {t(`campaign_${p.status}`)}
                {p.status === "unknown" ? ` (${p.externalStatus})` : ""}
              </dd>
              <dt className="text-text-500">{t("commission")}</dt>
              <dd className="font-semibold">{rate(p.commissionBasisPoints)}</dd>
              <dt className="text-text-500">{t("maxToday")}</dt>
              <dd>
                {p.maxCommissionBasisPointsToday === null ? t("notProvided") : rate(p.maxCommissionBasisPointsToday)}
              </dd>
            </dl>
          </TabsContent>
          <TabsContent value="period" className="grid gap-3">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-text-500">{t("starts")}</dt>
              <dd>{formatDateTime(p.startsAt, zone)}</dd>
              <dt className="text-text-500">{t("ends")}</dt>
              <dd>{p.endsAt ? formatDateTime(p.endsAt, zone) : t("unlimited")}</dd>
              {p.pendingTerminationAt ? (
                <>
                  <dt className="text-text-500">{t("termination")}</dt>
                  <dd>{formatDateTime(p.pendingTerminationAt, zone)}</dd>
                </>
              ) : null}
            </dl>
            <section className="grid gap-2 rounded-lg bg-surface-2 p-3 text-sm">
              <h3 className="font-medium">{t("protection")}</h3>
              {protection ? (
                <>
                  <p>
                    {rate(protection.commissionBasisPoints)} · {formatDateTime(protection.endsAt, zone)}
                  </p>
                  {p.protections.length > 1 ? (
                    <div className="flex items-center justify-between">
                      <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
                        {t("previous")}
                      </Button>
                      <span>
                        {page + 1}/{p.protections.length}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={page + 1 === p.protections.length}
                        onClick={() => setPage(page + 1)}
                      >
                        {t("next")}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-text-500">{t("noProtection")}</p>
              )}
            </section>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button onClick={onClose}>{t("close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
