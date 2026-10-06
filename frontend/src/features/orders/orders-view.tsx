"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { AlertOctagon, MoreHorizontal, PackageCheck, Plus, Search, ShoppingBag, Tag, Truck } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { FilterChip } from "@/components/common/filter-chip";
import { EmptyState, ErrorState, PageHeader, SlaPill, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useStores } from "@/features/stores/use-store-modes";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatNumber, formatRupiah } from "@/lib/format";
import { useCan } from "@/lib/session";
import { ArrangeDialog } from "./arrange-dialog";
import { OrderDetailSheet } from "./order-detail";
import { ORDER_TABS, type OrderListItem, STATUS_PILL, syncableStores, tabCount, tabOf } from "./order-meta";
import { TagDot, TagPicker, TagPills, TagsDialog, useTags } from "./tags";
import { useOrderActions } from "./use-order-actions";

const PAGE = 50;
const NONE: ReadonlySet<string> = new Set();
const ALL = "all";

/** Filters live in the URL, so a view can be shared and the notifications can link to one. */
function useOrderFilters() {
  const { params, set } = useUrlParams();
  const status = params.get("status");
  const tab = tabOf(status);
  const due = params.get("due");
  return {
    tab,
    q: params.get("q") ?? "",
    due: due === "soon" || due === "overdue" ? (due as "soon" | "overdue") : null,
    cod: params.get("cod") === "true",
    storeId: params.get("store"),
    warehouseId: params.get("warehouse"),
    tagId: params.get("tag"),
    openId: params.get("id"),
    set,
  };
}

/** The first unresolved problem of an order, in one sentence, for the row (L03, keadaan khusus). */
function problemText(order: OrderListItem, t: ReturnType<typeof useTranslations<"orders">>): string | null {
  const open = order.problems.find((p) => !p.resolvedAt);
  return open ? t(`problem_${open.code}`) : null;
}

/**
 * L03 Daftar Pesanan: every store's orders in one queue (DOKUMEN-UI-UX 14.2). Tabs with counts, a filter
 * bar, the table (cards on phones), bulk actions on the selected rows, and the detail in a side panel.
 */
export function OrdersView() {
  const t = useTranslations("orders");
  const tCommon = useTranslations("common");
  const can = useCan();
  const f = useOrderFilters();
  const { q, set } = f;
  const [search, setSearch] = useState(q);
  const [arranging, setArranging] = useState<string[] | null>(null);
  const [managingTags, setManagingTags] = useState(false);
  const queryClient = useQueryClient();

  // the search box writes the URL once the typing pauses
  useEffect(() => {
    if (search.trim() === q) return;
    const id = setTimeout(() => set({ q: search.trim() || null }), 300);
    return () => clearTimeout(id);
  }, [search, q, set]);

  const tabDef = ORDER_TABS.find((x) => x.key === f.tab)!;
  // query keys compare by value, so a new object per render is fine
  const query = {
    status: tabDef.statuses.length > 0 ? tabDef.statuses.join(",") : undefined,
    q: f.q || undefined,
    due: f.due ?? undefined,
    cod: f.cod ? ("true" as const) : undefined,
    storeId: f.storeId ?? undefined,
    warehouseId: f.warehouseId ?? undefined,
    tagId: f.tagId ?? undefined,
    sort: f.tab === "new" || f.due ? ("ship_by" as const) : ("newest" as const),
  };

  const summary = useQuery({
    queryKey: ["orders", "summary"],
    queryFn: () => unwrap(api.GET("/v1/orders/summary")),
    refetchInterval: 60_000,
  });
  const list = useInfiniteQuery({
    queryKey: ["orders", "list", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/orders", {
          params: { query: { ...query, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const orders = list.data?.pages.flatMap((p) => p.items) ?? [];

  // a selection belongs to the rows of one filter: another tab or search starts empty
  const selectionKey = JSON.stringify(query);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key: selectionKey,
    ids: new Set(),
  });
  const selected = selection.key === selectionKey ? selection.ids : NONE;
  const setSelected = (ids: ReadonlySet<string>) => setSelection({ key: selectionKey, ids });
  const actions = useOrderActions(() => setSelected(NONE));

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const allSelected = orders.length > 0 && orders.every((o) => selected.has(o.id));
  const ids = [...selected];
  const newCount = summary.data?.statuses.new ?? 0;
  const stores = useStores();
  const newWithoutProblems = orders.filter(
    (o) => o.status === "new" && !o.problems.some((p) => !p.resolvedAt) && !stores.readOnly(o.store?.id),
  );
  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
  });
  const warehouseList = warehouses.data?.items ?? [];
  const warehouseNames = new Map(warehouseList.map((w) => [w.id, w.name]));
  const showWarehouse = warehouseList.length > 1;
  const tags = useTags();
  const tagList = tags.data?.items ?? [];
  const storeList = [...stores.byId.values()];
  const syncable = can("settings:store") ? syncableStores(storeList) : [];
  const filtered = f.q || f.due || f.cod || f.storeId || f.warehouseId || f.tagId;
  const sync = useMutation({
    mutationFn: (store: { id: string; name: string }) =>
      unwrap(api.POST("/v1/orders/sync", { body: { storeId: store.id } })),
    onSuccess: (_, store) => {
      toast.success(t("syncQueued", { store: store.name }));
      // the worker reads the store in the background; look again once it had time to
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["orders"] }), 15_000);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={
          <>
            {can("order:tag") || syncable.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="icon" aria-label={t("moreActions")}>
                    <MoreHorizontal aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-56">
                  {can("order:tag") ? (
                    <DropdownMenuItem onSelect={() => setManagingTags(true)}>
                      <Tag aria-hidden />
                      {t("manageTags")}
                    </DropdownMenuItem>
                  ) : null}
                  {can("order:tag") && syncable.length > 0 ? <DropdownMenuSeparator /> : null}
                  {syncable.length > 0 ? <DropdownMenuLabel>{t("syncTitle")}</DropdownMenuLabel> : null}
                  {syncable.map((st) => (
                    <DropdownMenuItem key={st.id} disabled={sync.isPending} onSelect={() => sync.mutate(st)}>
                      <ChannelIcon channel={st.channel} decorative />
                      {st.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {can("order:write") ? (
              <Button asChild variant="secondary">
                <Link href="/pesanan/baru">
                  <Plus aria-hidden />
                  {t("manualOrder")}
                </Link>
              </Button>
            ) : null}
            {!can("shipment:arrange") ? null : f.tab === "new" ? (
              newWithoutProblems.length > 0 ? (
                <Button onClick={() => setArranging(newWithoutProblems.map((o) => o.id))}>
                  <Truck aria-hidden />
                  {t("processAllNew", { count: newWithoutProblems.length })}
                </Button>
              ) : null
            ) : newCount > 0 ? (
              <Button onClick={() => set({ status: "new", id: null })}>
                <Truck aria-hidden />
                {t("processNew", { count: newCount })}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="-mx-4 mb-3 overflow-x-auto border-b px-4 md:mx-0 md:px-0" role="tablist" aria-label={t("tabs")}>
        <div className="flex min-w-max gap-1">
          {ORDER_TABS.map((tab) => {
            const count = summary.data ? tabCount(tab.key, summary.data.statuses) : null;
            const active = f.tab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() =>
                  set({ status: tab.key === "all" ? null : tab.statuses.length === 1 ? tab.statuses[0]! : tab.key })
                }
                className={cn(
                  "-mb-px flex h-11 items-center gap-1.5 border-b-2 border-transparent px-3 text-[15px] font-medium text-text-700 outline-none hover:text-text-900 focus-visible:ring-2 focus-visible:ring-ring",
                  active && "border-primary text-primary-600",
                )}
              >
                {t(`tab_${tab.key}`)}
                {count !== null && count > 0 ? (
                  <span
                    className={cn(
                      "tabular rounded-full px-1.5 text-[13px]",
                      tab.key === "problem" ? "bg-danger-soft text-danger" : "bg-surface-2 text-text-700",
                    )}
                  >
                    {formatNumber(count)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-primary-100 bg-primary-50 px-3 py-2">
          <span className="text-sm font-medium text-text-900">{t("selected", { count: selected.size })}</span>
          {can("order:accept") ? (
            <Button
              size="sm"
              variant="secondary"
              loading={actions.accept.isPending}
              onClick={() => actions.accept.mutate(ids)}
            >
              {t("accept")}
            </Button>
          ) : null}
          {can("shipment:arrange") ? (
            <Button size="sm" variant="secondary" onClick={() => setArranging(ids)}>
              <Truck aria-hidden />
              {t("arrange")}
            </Button>
          ) : null}
          {can("shipment:pack") ? (
            <Button
              size="sm"
              variant="secondary"
              loading={actions.pack.isPending}
              onClick={() => actions.pack.mutate(ids)}
            >
              <PackageCheck aria-hidden />
              {t("markPacked")}
            </Button>
          ) : null}
          {can("order:tag") ? (
            <TagPicker
              orders={orders.filter((o) => selected.has(o.id))}
              onManage={() => setManagingTags(true)}
              onApplied={() => setSelected(NONE)}
              trigger={
                <Button size="sm" variant="secondary">
                  <Tag aria-hidden />
                  {t("tagOrders")}
                </Button>
              }
            />
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setSelected(NONE)}>
            {t("clearSelection")}
          </Button>
        </div>
      ) : (
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
              aria-label={tCommon("search")}
              className="pl-9"
            />
          </div>
          <FilterChip active={f.due === "soon"} onClick={() => set({ due: f.due === "soon" ? null : "soon" })}>
            {t("dueSoon")}
          </FilterChip>
          <FilterChip active={f.cod} onClick={() => set({ cod: f.cod ? null : "true" })}>
            {t("codOnly")}
          </FilterChip>
          {storeList.length > 1 ? (
            <Select value={f.storeId ?? ALL} onValueChange={(v) => set({ store: v === ALL ? null : v })}>
              <SelectTrigger className="h-10 w-44" aria-label={t("filterStore")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("allStores")}</SelectItem>
                {storeList.map((st) => (
                  <SelectItem key={st.id} value={st.id}>
                    {st.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {showWarehouse ? (
            <Select value={f.warehouseId ?? ALL} onValueChange={(v) => set({ warehouse: v === ALL ? null : v })}>
              <SelectTrigger className="h-10 w-44" aria-label={t("filterWarehouse")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{tCommon("allWarehouses")}</SelectItem>
                {warehouseList.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {tagList.length > 0 ? (
            <Select value={f.tagId ?? ALL} onValueChange={(v) => set({ tag: v === ALL ? null : v })}>
              <SelectTrigger className="h-10 w-40" aria-label={t("filterTag")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("allTags")}</SelectItem>
                {tagList.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>
                    <TagDot color={tag.color} />
                    {tag.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                set({ q: null, due: null, cod: null, store: null, warehouse: null, tag: null });
              }}
            >
              {tCommon("clear")}
            </Button>
          ) : null}
        </div>
      )}

      <Card className="gap-0 py-0">
        {list.isPending ? (
          <div className="grid gap-2 p-4" aria-busy>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : orders.length === 0 ? (
          <EmptyState
            icon={ShoppingBag}
            title={filtered ? t("emptyFiltered") : f.tab === "new" ? t("emptyNew") : t("empty")}
            body={filtered ? undefined : t("emptyBody")}
          />
        ) : (
          <>
            <Table className="hidden md:table">
              <TableHeader className="bg-surface-2">
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(v) => setSelected(v === true ? new Set(orders.map((o) => o.id)) : NONE)}
                      aria-label={t("selectAll")}
                    />
                  </TableHead>
                  <TableHead>{t("colOrder")}</TableHead>
                  <TableHead>{t("colBuyer")}</TableHead>
                  <TableHead>{t("colProducts")}</TableHead>
                  <TableHead className="text-right">{t("colTotal")}</TableHead>
                  <TableHead>{t("colCourier")}</TableHead>
                  {showWarehouse ? <TableHead>{t("colWarehouse")}</TableHead> : null}
                  <TableHead>{t("colShipBy")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => {
                  const problem = problemText(o, t);
                  return (
                    <TableRow
                      key={o.id}
                      data-state={selected.has(o.id) ? "selected" : undefined}
                      className={cn("h-[52px] cursor-pointer", problem && "bg-danger-soft/40")}
                      onClick={() => set({ id: o.id })}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selected.has(o.id)}
                          onCheckedChange={(v) => toggle(o.id, v === true)}
                          aria-label={t("selectOrder", { number: o.externalOrderId })}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="grid gap-0.5">
                          <span className="font-mono text-sm font-medium text-text-900">{o.externalOrderId}</span>
                          <span className="flex items-center gap-1.5 text-[13px] text-text-500">
                            {o.store ? <ChannelIcon channel={o.store.channel} /> : null}
                            {o.store?.name}
                          </span>
                          {problem ? (
                            <span className="flex items-center gap-1 text-[13px] text-danger">
                              <AlertOctagon className="size-3.5" aria-hidden />
                              {problem}
                            </span>
                          ) : null}
                          <TagPills tags={o.tags} />
                        </div>
                      </TableCell>
                      <TableCell className="max-w-40 truncate">{o.buyerName ?? "—"}</TableCell>
                      <TableCell className="max-w-64">
                        <span className="block truncate" title={o.firstItem?.title}>
                          {o.firstItem?.title ?? "—"}
                        </span>
                        {o.itemCount > 1 ? (
                          <span className="text-[13px] text-text-500">
                            {t("moreItems", { count: o.itemCount - 1 })}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {formatRupiah(o.total)}
                        {o.isCod ? (
                          <span className="ml-1.5 rounded bg-warning-soft px-1 text-[11px] font-semibold text-warning">
                            COD
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-36 truncate">{o.shippingProvider ?? "—"}</TableCell>
                      {showWarehouse ? (
                        <TableCell className="max-w-36 truncate text-text-700">
                          {o.warehouseId ? (warehouseNames.get(o.warehouseId) ?? "—") : "—"}
                        </TableCell>
                      ) : null}
                      <TableCell>
                        {o.sla ? <SlaPill sla={o.sla} /> : <span className="text-text-500">—</span>}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={STATUS_PILL[o.status].tone} icon={STATUS_PILL[o.status].icon}>
                          {o.statusLabel}
                        </StatusPill>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            <ul className="divide-y md:hidden">
              {orders.map((o) => {
                const problem = problemText(o, t);
                return (
                  <li key={o.id} className={cn("flex gap-3 p-4", problem && "bg-danger-soft/40")}>
                    <Checkbox
                      checked={selected.has(o.id)}
                      onCheckedChange={(v) => toggle(o.id, v === true)}
                      aria-label={t("selectOrder", { number: o.externalOrderId })}
                      className="mt-1"
                    />
                    <button
                      type="button"
                      className="grid min-w-0 flex-1 gap-1 text-left"
                      onClick={() => set({ id: o.id })}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-sm font-medium text-text-900">
                          {o.externalOrderId}
                        </span>
                        <StatusPill tone={STATUS_PILL[o.status].tone} icon={STATUS_PILL[o.status].icon}>
                          {o.statusLabel}
                        </StatusPill>
                      </span>
                      <span className="truncate text-sm text-text-700">
                        {o.firstItem?.title ?? "—"}
                        {o.itemCount > 1 ? ` ${t("moreOthers", { count: o.itemCount - 1 })}` : ""}
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className="tabular text-sm font-semibold text-text-900">{formatRupiah(o.total)}</span>
                        {o.sla ? <SlaPill sla={o.sla} /> : null}
                      </span>
                      <span className="flex items-center gap-1.5 text-[13px] text-text-500">
                        {o.store ? <ChannelIcon channel={o.store.channel} /> : null}
                        {o.store?.name}
                        {o.shippingProvider ? ` · ${o.shippingProvider}` : ""}
                      </span>
                      {problem ? <span className="text-[13px] text-danger">{problem}</span> : null}
                      <TagPills tags={o.tags} />
                    </button>
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
          </>
        )}
      </Card>

      <OrderDetailSheet orderId={f.openId} onClose={() => set({ id: null })} />
      <TagsDialog open={managingTags} onClose={() => setManagingTags(false)} />
      <ArrangeDialog
        orderIds={arranging}
        busy={actions.arrange.isPending}
        onClose={() => setArranging(null)}
        onConfirm={(method) => {
          if (!arranging) return;
          actions.arrange.mutate({ orderIds: arranging, method }, { onSettled: () => setArranging(null) });
        }}
      />
    </>
  );
}
