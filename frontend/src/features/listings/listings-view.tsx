"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Link2, PackagePlus, Power, PowerOff, RefreshCw, Search, Store, Unlink, Wand2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { SelectionBar } from "@/components/common/selection-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  bestSuggestion,
  type Listing,
  mappedPercent,
  type Suggestion,
  type UnmappedListing,
  variantLabel,
} from "@/features/products/product-meta";
import { Thumb } from "@/features/products/products-view";
import { usableStore } from "@/features/stores/store-meta";
import { useStores } from "@/features/stores/use-store-modes";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatNumber, formatRupiah } from "@/lib/format";
import { useCan } from "@/lib/session";
import { marketplaceItems, switchable } from "./listing-status";

const PAGE = 50;
const ALL = "all";
const NONE: ReadonlySet<string> = new Set();

/**
 * L15 Listing Toko dan Pemetaan SKU (DOKUMEN-UI-UX 14.3): every marketplace listing must lead to a master
 * variant before its stock can be pushed; this is the onboarding's most important step.
 */
export function ListingsView() {
  const t = useTranslations("listings");
  const can = useCan();
  const queryClient = useQueryClient();
  const { params, set } = useUrlParams();
  const tab = params.get("tab") === "all" ? "all" : "unmapped";
  const storeId = params.get("store");
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const stores = useStores();
  const marketplaceStores = [...stores.byId.values()].filter(
    (s) => s.channel !== "manual" && s.status !== "disconnected",
  );

  useEffect(() => {
    if (search.trim() === q) return;
    const id = setTimeout(() => set({ q: search.trim() || null }), 300);
    return () => clearTimeout(id);
  }, [search, q, set]);

  const summary = useQuery({
    queryKey: ["listings", "summary", storeId],
    queryFn: () => unwrap(api.GET("/v1/listings/summary", { params: { query: storeId ? { storeId } : {} } })),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["listings"] });
    void queryClient.invalidateQueries({ queryKey: ["products"] });
  };
  const autoMap = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/listings/auto-map", { body: storeId ? { storeId } : {} })),
    onSuccess: (r) => {
      toast.success(r.mapped > 0 ? t("autoMapped", { count: r.mapped }) : t("autoMappedNone"));
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const pull = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/v1/listings/sync", { body: { storeId: id, full: false } })),
    onSuccess: () => toast.success(t("pullQueued")),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const s = summary.data;

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <>
            {can("catalog:write") && marketplaceStores.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" loading={pull.isPending}>
                    <RefreshCw aria-hidden />
                    {t("pull")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {marketplaceStores.map((st) => (
                    <DropdownMenuItem key={st.id} onSelect={() => pull.mutate(st.id)}>
                      <ChannelIcon channel={st.channel} decorative />
                      {st.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {can("catalog:map") ? (
              <Button loading={autoMap.isPending} onClick={() => autoMap.mutate()}>
                <Wand2 aria-hidden />
                {t("autoMap")}
              </Button>
            ) : null}
          </>
        }
      />

      <section
        className="mb-4 grid gap-2 rounded-[10px] border border-primary-100 bg-primary-50 p-4"
        aria-live="polite"
      >
        {s ? (
          <>
            <p className="text-sm font-medium text-text-900">
              {t("progress", { mapped: formatNumber(s.mapped), total: formatNumber(s.total), pct: mappedPercent(s) })}
            </p>
            <Progress value={mappedPercent(s)} aria-label={t("progressLabel")} />
            {s.unmapped > 0 ? <p className="text-[13px] text-text-700">{t("progressHint")}</p> : null}
          </>
        ) : (
          <Skeleton className="h-10" />
        )}
      </section>

      <div className="-mx-4 mb-3 overflow-x-auto border-b px-4 md:mx-0 md:px-0" role="tablist" aria-label={t("tabs")}>
        <div className="flex min-w-max gap-1">
          {(["unmapped", "all"] as const).map((x) => (
            <button
              key={x}
              type="button"
              role="tab"
              aria-selected={tab === x}
              onClick={() => set({ tab: x === "unmapped" ? null : x })}
              className={cn(
                "-mb-px flex h-11 items-center gap-1.5 border-b-2 border-transparent px-3 text-[15px] font-medium text-text-700 outline-none hover:text-text-900 focus-visible:ring-2 focus-visible:ring-ring",
                tab === x && "border-primary text-primary-600",
              )}
            >
              {t(`tab_${x}`)}
              {x === "unmapped" && s && s.unmapped > 0 ? (
                <span className="tabular rounded-full bg-surface-2 px-1.5 text-[13px] text-text-700">
                  {formatNumber(s.unmapped)}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 md:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="pl-9"
          />
        </div>
        {marketplaceStores.length > 1 ? (
          <Select value={storeId ?? ALL} onValueChange={(v) => set({ store: v === ALL ? null : v })}>
            <SelectTrigger className="h-10 w-56" aria-label={t("store")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allStores")}</SelectItem>
              {marketplaceStores.map((st) => (
                <SelectItem key={st.id} value={st.id}>
                  {st.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {tab === "unmapped" ? (
        can("catalog:map") ? (
          <UnmappedList storeId={storeId} q={q} onChanged={refresh} />
        ) : (
          <Card>
            <EmptyState icon={Store} title={t("noMapPermission")} />
          </Card>
        )
      ) : (
        <AllList storeId={storeId} q={q} onChanged={refresh} />
      )}
    </>
  );
}

/** Purple stays for suggestions made by AI (L15); a name match is plain trigram arithmetic. */
function SuggestionBadge({ s }: { s: Suggestion }) {
  const t = useTranslations("listings");
  return s.reason === "sku" ? (
    <StatusPill tone="success">{t("sameSku")}</StatusPill>
  ) : (
    <StatusPill tone="info">{t("similarName", { pct: Math.round(s.score * 100) })}</StatusPill>
  );
}

function UnmappedList({ storeId, q, onChanged }: { storeId: string | null; q: string; onChanged: () => void }) {
  const t = useTranslations("listings");
  const tCommon = useTranslations("common");
  const can = useCan();
  const query = { ...(storeId ? { storeId } : {}), ...(q ? { q } : {}) };
  const key = JSON.stringify(query);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>({ key, ids: NONE });
  const selected = selection.key === key ? selection.ids : NONE;
  const setSelected = (ids: ReadonlySet<string>) => setSelection({ key, ids });
  const [picking, setPicking] = useState<UnmappedListing | null>(null);
  const list = useInfiniteQuery({
    queryKey: ["listings", "unmapped", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/listings/unmapped", {
          params: { query: { ...query, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const map = useMutation({
    mutationFn: (input: { listingId: string; variantId: string }) =>
      unwrap(
        api.PUT("/v1/listings/{id}/mapping", {
          params: { path: { id: input.listingId } },
          body: { variantId: input.variantId },
        }),
      ),
    onSuccess: (l) => {
      toast.success(t("mapped", { title: l.title, sku: l.mapping?.sku ?? "" }));
      setPicking(null);
      onChanged();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const create = useMutation({
    mutationFn: (listingIds: string[]) => unwrap(api.POST("/v1/listings/create-products", { body: { listingIds } })),
    onSuccess: (r) => {
      if (r.created.length + r.mappedToExisting.length > 0) {
        toast.success(t("createdFrom", { created: r.created.length, existing: r.mappedToExisting.length }));
      }
      if (r.failed.length > 0) toast.error(r.failed[0]!.message);
      setSelected(NONE);
      onChanged();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  if (list.isPending) return <ListSkeleton />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState icon={Link2} title={t("allMapped")} body={t("allMappedBody")} />
      </Card>
    );
  }
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  return (
    <>
      {selected.size > 0 && can("catalog:write") ? (
        <SelectionBar count={t("selected", { count: selected.size })}>
          <Button size="sm" variant="secondary" loading={create.isPending} onClick={() => create.mutate([...selected])}>
            <PackagePlus aria-hidden />
            {t("createProducts")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(NONE)}>
            {t("clearSelection")}
          </Button>
        </SelectionBar>
      ) : null}
      <Card className="gap-0 py-0">
        <ul className="divide-y">
          {rows.map((l) => {
            const best = bestSuggestion(l);
            return (
              <li
                key={l.id}
                className="grid gap-3 p-4 lg:grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1fr)_auto] lg:items-center"
              >
                <Checkbox
                  checked={selected.has(l.id)}
                  onCheckedChange={(v) => toggle(l.id, v === true)}
                  aria-label={t("selectListing", { title: l.title })}
                  className="hidden lg:flex"
                />
                <div className="flex min-w-0 gap-3">
                  <Thumb url={l.imageUrl} size={56} />
                  <div className="grid min-w-0 gap-0.5 text-sm">
                    <span className="line-clamp-2 font-medium text-text-900">{l.title}</span>
                    {l.variantName ? <span className="text-[13px] text-text-700">{l.variantName}</span> : null}
                    <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-text-500">
                      {l.store ? (
                        <span className="flex items-center gap-1">
                          <ChannelIcon channel={l.store.channel} decorative />
                          {l.store.name}
                        </span>
                      ) : null}
                      <span className="font-mono text-text-700">{l.sku ?? t("noSku")}</span>
                      {l.price !== null ? <span className="tabular">{formatRupiah(l.price)}</span> : null}
                    </span>
                  </div>
                </div>
                <div className="grid min-w-0 gap-1 text-sm">
                  {best ? (
                    <>
                      <span className="flex flex-wrap items-center gap-2">
                        <SuggestionBadge s={best} />
                        <span className="font-mono text-[13px] text-text-900">{best.sku}</span>
                      </span>
                      <span className="truncate text-[13px] text-text-700">
                        {best.productName} · {best.variantName}
                      </span>
                    </>
                  ) : (
                    <span className="text-[13px] text-text-500">{t("noSuggestion")}</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  {best ? (
                    <Button
                      size="sm"
                      loading={map.isPending && map.variables?.listingId === l.id}
                      onClick={() => map.mutate({ listingId: l.id, variantId: best.variantId })}
                    >
                      <Link2 aria-hidden />
                      {t("connect")}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="secondary" onClick={() => setPicking(l)}>
                    {t("pickManually")}
                  </Button>
                  {can("catalog:write") ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={create.isPending && create.variables?.length === 1 && create.variables[0] === l.id}
                      onClick={() => create.mutate([l.id])}
                    >
                      <PackagePlus aria-hidden />
                      {t("createProduct")}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {list.hasNextPage ? (
          <div className="border-t p-3 text-center">
            <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              {tCommon("loadMore")}
            </Button>
          </div>
        ) : null}
      </Card>
      <VariantPicker
        listing={picking}
        busy={map.isPending}
        onClose={() => setPicking(null)}
        onPick={(variantId) => picking && map.mutate({ listingId: picking.id, variantId })}
      />
    </>
  );
}

function AllList({ storeId, q, onChanged }: { storeId: string | null; q: string; onChanged: () => void }) {
  const t = useTranslations("listings");
  const tCommon = useTranslations("common");
  const can = useCan();
  const queryClient = useQueryClient();
  const stores = useStores();
  const [picking, setPicking] = useState<Listing | null>(null);
  const query = { ...(storeId ? { storeId } : {}), ...(q ? { q } : {}) };
  // a selection belongs to the rows of one filter
  const key = JSON.stringify(query);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>({ key, ids: NONE });
  const selected = selection.key === key ? selection.ids : NONE;
  const setSelected = (ids: ReadonlySet<string>) => setSelection({ key, ids });
  // which action the dialog asks about stays set while it closes, so its text does not flip mid-fade
  const [confirm, setConfirm] = useState<{ open: boolean; active: boolean }>({ open: false, active: true });
  const closeConfirm = () => setConfirm((c) => ({ ...c, open: false }));
  const publishes = can("catalog:publish");
  const usable = (l: Listing) => {
    const s = stores.byId.get(l.storeId);
    return s ? usableStore(s.status) : false;
  };
  const list = useInfiniteQuery({
    queryKey: ["listings", "all", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/listings", {
          params: { query: { ...query, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const map = useMutation({
    mutationFn: (input: { listingId: string; variantId: string | null }) =>
      unwrap(
        api.PUT("/v1/listings/{id}/mapping", {
          params: { path: { id: input.listingId } },
          body: { variantId: input.variantId },
        }),
      ),
    onSuccess: (l) => {
      toast.success(
        l.mapping ? t("mapped", { title: l.title, sku: l.mapping.sku }) : t("unmappedDone", { title: l.title }),
      );
      setPicking(null);
      onChanged();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const setStatus = useMutation({
    mutationFn: (active: boolean) =>
      unwrap(api.POST("/v1/listings/status", { body: { listingIds: [...selected], active } })),
    onSuccess: (r, active) => {
      toast.success(t(active ? "activateQueued" : "deactivateQueued", { items: r.items, stores: r.stores }));
      setSelected(NONE);
      closeConfirm();
      // the worker tells the marketplace; the list shows the new status once it is read back
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["listings"] }), 8_000);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const chosen = rows.filter((l) => selected.has(l.id));
  if (list.isPending) return <ListSkeleton />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState icon={Store} title={t("empty")} body={t("emptyBody")} />
      </Card>
    );
  }
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  return (
    <>
      {selected.size > 0 ? (
        <SelectionBar count={t("selected", { count: selected.size })}>
          <Button size="sm" variant="secondary" onClick={() => setConfirm({ open: true, active: true })}>
            <Power aria-hidden />
            {t("activate")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setConfirm({ open: true, active: false })}>
            <PowerOff aria-hidden />
            {t("deactivate")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(NONE)}>
            {t("clearSelection")}
          </Button>
        </SelectionBar>
      ) : null}
      <Card className="gap-0 py-0">
        <ul className="divide-y">
          {rows.map((l) => (
            <li
              key={l.id}
              className={cn(
                "grid gap-3 p-4 lg:items-center",
                publishes
                  ? "lg:grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1fr)_auto]"
                  : "lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto]",
              )}
            >
              {publishes ? (
                switchable(l, usable(l)) ? (
                  <Checkbox
                    checked={selected.has(l.id)}
                    onCheckedChange={(v) => toggle(l.id, v === true)}
                    aria-label={t("selectListing", { title: l.title })}
                  />
                ) : (
                  <span className="hidden size-4 lg:block" aria-hidden />
                )
              ) : null}
              <div className="flex min-w-0 gap-3">
                <Thumb url={l.imageUrl} size={56} />
                <div className="grid min-w-0 gap-0.5 text-sm">
                  <span className="line-clamp-2 font-medium text-text-900">{l.title}</span>
                  {l.variantName ? <span className="text-[13px] text-text-700">{l.variantName}</span> : null}
                  <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-text-500">
                    {l.store ? (
                      <span className="flex items-center gap-1">
                        <ChannelIcon channel={l.store.channel} decorative />
                        {l.store.name}
                      </span>
                    ) : null}
                    <span className="font-mono text-text-700">{l.sku ?? t("noSku")}</span>
                    <StatusPill tone={l.status === "active" ? "success" : l.status === "banned" ? "danger" : "neutral"}>
                      {t(`status_${l.status}`)}
                    </StatusPill>
                  </span>
                </div>
              </div>
              <div className="grid min-w-0 gap-0.5 text-sm">
                {l.mapping ? (
                  <>
                    <span className="font-mono text-[13px] text-text-900">{l.mapping.sku}</span>
                    <span className="truncate text-[13px] text-text-700">
                      {l.mapping.productName} · {l.mapping.variantName}
                    </span>
                  </>
                ) : (
                  <StatusPill tone="warning" className="justify-self-start">
                    {t("notMapped")}
                  </StatusPill>
                )}
              </div>
              {can("catalog:map") ? (
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <Button size="sm" variant="secondary" onClick={() => setPicking(l)}>
                    {l.mapping ? t("change") : t("pickManually")}
                  </Button>
                  {l.mapping ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={map.isPending && map.variables?.listingId === l.id && map.variables.variantId === null}
                      onClick={() => map.mutate({ listingId: l.id, variantId: null })}
                    >
                      <Unlink aria-hidden />
                      {t("unmap")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {list.hasNextPage ? (
          <div className="border-t p-3 text-center">
            <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              {tCommon("loadMore")}
            </Button>
          </div>
        ) : null}
      </Card>
      <VariantPicker
        listing={picking}
        busy={map.isPending}
        onClose={() => setPicking(null)}
        onPick={(variantId) => picking && map.mutate({ listingId: picking.id, variantId })}
      />
      <Dialog open={confirm.open} onOpenChange={(v) => !v && closeConfirm()}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{t(confirm.active ? "activateTitle" : "deactivateTitle")}</DialogTitle>
            <DialogDescription>
              {t("statusBody", { count: chosen.length, items: marketplaceItems(chosen) })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={closeConfirm}>
              {tCommon("cancel")}
            </Button>
            <Button
              variant={confirm.active ? "default" : "destructive"}
              loading={setStatus.isPending}
              onClick={() => setStatus.mutate(confirm.active)}
            >
              {t(confirm.active ? "activate" : "deactivate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ListSkeleton() {
  return (
    <div className="grid gap-2 rounded-[10px] border bg-surface p-4" aria-busy>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-14" />
      ))}
    </div>
  );
}

/** "Cari manual": find the master variant a listing sells, by product name or SKU. */
function VariantPicker({
  listing,
  busy,
  onClose,
  onPick,
}: {
  listing: Pick<Listing, "title" | "sku"> | null;
  busy: boolean;
  onClose: () => void;
  onPick: (variantId: string) => void;
}) {
  const t = useTranslations("listings");
  const [q, setQ] = useState("");
  useEffect(() => {
    if (listing) setQ(listing.sku ?? "");
  }, [listing]);
  const term = q.trim();
  const products = useQuery({
    queryKey: ["products", "pick", term],
    queryFn: () => unwrap(api.GET("/v1/products", { params: { query: { q: term, status: "active", limit: 10 } } })),
    enabled: listing !== null && term.length >= 2,
  });
  const variants = (products.data?.items ?? []).flatMap((p) =>
    p.variants.filter((v) => v.status === "active").map((v) => ({ product: p, variant: v })),
  );
  return (
    <Dialog open={listing !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("pickTitle")}</DialogTitle>
          <DialogDescription>{listing ? t("pickBody", { title: listing.title }) : null}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
            aria-hidden
          />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("pickPlaceholder")}
            aria-label={t("pickPlaceholder")}
            className="pl-9"
          />
        </div>
        {term.length < 2 ? (
          <p className="text-sm text-text-500">{t("pickHint")}</p>
        ) : products.isPending ? (
          <Skeleton className="h-24" />
        ) : variants.length === 0 ? (
          <p className="text-sm text-text-500">{t("pickNone")}</p>
        ) : (
          <ul className="grid max-h-80 gap-1 overflow-y-auto">
            {variants.map(({ product, variant }) => (
              <li key={variant.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(variant.id)}
                  className="grid w-full gap-0.5 rounded-lg px-3 py-2 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <span className="font-mono text-sm text-text-900">{variant.sku}</span>
                  <span className="truncate text-[13px] text-text-500">
                    {product.name} · {variantLabel(variant)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
