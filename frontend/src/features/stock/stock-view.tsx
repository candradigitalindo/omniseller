"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { AlertTriangle, Boxes, Search, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useEffect, useState } from "react";
import { ChannelIcon } from "@/components/common/channel";
import { FilterChip } from "@/components/common/filter-chip";
import { EmptyState, ErrorState, PageHeader } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime, formatNumber, formatRupiah } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import { AdjustStockDialog, variantTitle } from "./adjust-dialog";
import { PUSH_TONE, STOCK_FILTERS, type StockCell, type StockRow, stockFilterOf, warehouseColumns } from "./stock-meta";

const PAGE = 50;
const ALL = "all";

function useStockFilters() {
  const { params, set } = useUrlParams();
  return {
    q: params.get("q") ?? "",
    stock: stockFilterOf(params.get("stock")),
    warehouseId: params.get("warehouse"),
    set,
  };
}

/**
 * L19 Stok (DOKUMEN-UI-UX 14.4): ready-to-sell stock per SKU and warehouse, what reached each marketplace,
 * and "Sesuaikan stok". Filters live in the URL (`?stock=low` from the dashboard and notifications).
 */
export function StockView() {
  const t = useTranslations("stock");
  const tCommon = useTranslations("common");
  const can = useCan();
  const f = useStockFilters();
  const { q, set } = f;
  const [search, setSearch] = useState(q);
  const [adjusting, setAdjusting] = useState<{ row: StockRow | null } | null>(null);

  // the search box writes the URL once the typing pauses
  useEffect(() => {
    if (search.trim() === q) return;
    const id = setTimeout(() => set({ q: search.trim() || null }), 300);
    return () => clearTimeout(id);
  }, [search, q, set]);

  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
  });
  const summary = useQuery({
    queryKey: ["stock", "summary", f.warehouseId],
    queryFn: () =>
      unwrap(
        api.GET("/v1/inventory/summary", { params: { query: f.warehouseId ? { warehouseId: f.warehouseId } : {} } }),
      ),
  });
  const query = {
    ...(f.q ? { q: f.q } : {}),
    ...(f.stock ? { stock: f.stock } : {}),
    ...(f.warehouseId ? { warehouseId: f.warehouseId } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: ["stock", "list", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/inventory", {
          params: { query: { ...query, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const allWarehouses = warehouses.data?.items ?? [];
  const columns = warehouseColumns(allWarehouses, f.warehouseId);
  const canAdjust = can("inventory:adjust");

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={
          canAdjust ? (
            <Button onClick={() => setAdjusting({ row: null })}>
              <SlidersHorizontal aria-hidden />
              {t("adjustTitle")}
            </Button>
          ) : null
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("kpiSkus")} value={summary.data ? formatNumber(summary.data.skus) : null} />
        <Kpi
          label={t("kpiLow")}
          value={summary.data ? formatNumber(summary.data.low) : null}
          tone={summary.data && summary.data.low > 0 ? "warning" : undefined}
          onClick={() => f.set({ stock: f.stock === "low" ? null : "low" })}
        />
        <Kpi
          label={t("kpiOut")}
          value={summary.data ? formatNumber(summary.data.out) : null}
          tone={summary.data && summary.data.out > 0 ? "danger" : undefined}
          onClick={() => f.set({ stock: f.stock === "out" ? null : "out" })}
        />
        {summary.data?.value === null ? (
          <Kpi
            label={t("kpiUnset")}
            value={formatNumber(summary.data.unset)}
            onClick={() => f.set({ stock: f.stock === "unset" ? null : "unset" })}
          />
        ) : (
          <Kpi label={t("kpiValue")} value={summary.data ? formatRupiah(summary.data.value ?? 0) : null} />
        )}
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
            aria-label={tCommon("search")}
            className="pl-9"
          />
        </div>
        {allWarehouses.length > 1 ? (
          <Select value={f.warehouseId ?? ALL} onValueChange={(v) => f.set({ warehouse: v === ALL ? null : v })}>
            <SelectTrigger className="h-10 w-48" aria-label={t("warehouse")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tCommon("allWarehouses")}</SelectItem>
              {allWarehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {/* one row that scrolls sideways on phones */}
        <div className="-mx-4 flex w-[calc(100%+2rem)] gap-2 overflow-x-auto px-4 md:mx-0 md:w-auto md:overflow-visible md:px-0">
          {STOCK_FILTERS.map((s) => (
            <FilterChip key={s} active={f.stock === s} onClick={() => f.set({ stock: f.stock === s ? null : s })}>
              {t(`filter_${s}`)}
              {summary.data && summary.data[s] > 0 ? (
                <span className="tabular text-[13px] opacity-80">{formatNumber(summary.data[s])}</span>
              ) : null}
            </FilterChip>
          ))}
        </div>
      </div>

      <Card className="gap-0 py-0">
        {list.isPending || warehouses.isPending ? (
          <div className="grid gap-2 p-4" aria-busy>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title={f.q || f.stock ? t("emptyFiltered") : t("empty")}
            body={f.q || f.stock ? undefined : t("emptyBody")}
          />
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader className="bg-surface-2">
                  <TableRow>
                    <TableHead rowSpan={2} className="min-w-56 align-bottom">
                      {t("colProduct")}
                    </TableHead>
                    {columns.map((w) => (
                      <TableHead key={w.id} colSpan={4} className="border-l text-center">
                        {w.name}
                      </TableHead>
                    ))}
                    <TableHead rowSpan={2} className="border-l align-bottom">
                      {t("colPush")}
                    </TableHead>
                    {canAdjust ? <TableHead rowSpan={2} className="w-px" /> : null}
                  </TableRow>
                  <TableRow>
                    {columns.map((w) => (
                      <Fragment key={w.id}>
                        <TableHead className="border-l text-right text-[13px]">{t("onHand")}</TableHead>
                        <TableHead className="text-right text-[13px]">{t("reserved")}</TableHead>
                        <TableHead className="text-right text-[13px]">{t("buffer")}</TableHead>
                        <TableHead className="text-right text-[13px]">{t("available")}</TableHead>
                      </Fragment>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} className="h-[52px]">
                      <TableCell className="max-w-72">
                        <div className="grid gap-0.5">
                          <span className="font-mono text-sm text-text-900">{r.sku}</span>
                          <span className="truncate text-[13px] text-text-500" title={variantTitle(r)}>
                            {variantTitle(r)}
                          </span>
                          {!r.established ? (
                            <span className="text-[13px] text-warning">{t("notEstablished")}</span>
                          ) : null}
                        </div>
                      </TableCell>
                      {columns.map((w) => (
                        <StockCells key={w.id} cell={r.warehouses.find((c) => c.warehouseId === w.id)} />
                      ))}
                      <TableCell className="border-l">
                        <PushIcons push={r.push} />
                      </TableCell>
                      {canAdjust ? (
                        <TableCell>
                          <Button size="sm" variant="secondary" onClick={() => setAdjusting({ row: r })}>
                            {t("adjust")}
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <ul className="divide-y md:hidden">
              {rows.map((r) => (
                <li key={r.id} className="grid gap-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="grid min-w-0 gap-0.5">
                      <span className="font-mono text-sm text-text-900">{r.sku}</span>
                      <span className="truncate text-[13px] text-text-500">{variantTitle(r)}</span>
                    </div>
                    <div className="grid justify-items-end">
                      <Available value={r.available} large />
                      <span className="text-[12px] text-text-500">{t("available")}</span>
                    </div>
                  </div>
                  {!r.established ? <span className="text-[13px] text-warning">{t("notEstablished")}</span> : null}
                  <div className="flex items-center justify-between gap-2">
                    <PushIcons push={r.push} />
                    {canAdjust ? (
                      <Button size="sm" variant="secondary" onClick={() => setAdjusting({ row: r })}>
                        {t("adjust")}
                      </Button>
                    ) : null}
                  </div>
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
          </>
        )}
      </Card>

      <AdjustStockDialog
        open={adjusting !== null}
        row={adjusting?.row ?? null}
        warehouses={allWarehouses}
        warehouseId={f.warehouseId}
        onClose={() => setAdjusting(null)}
      />
    </>
  );
}

function Kpi({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: string | null;
  tone?: "warning" | "danger" | undefined;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="text-[13px] text-text-500">{label}</span>
      {value === null ? (
        <Skeleton className="h-7 w-20" />
      ) : (
        <span
          className={cn(
            "tabular text-lg font-bold whitespace-nowrap text-text-900 md:text-xl",
            tone === "warning" && "text-warning",
            tone === "danger" && "text-danger",
          )}
        >
          {value}
        </span>
      )}
    </>
  );
  const className = "grid gap-1 rounded-[10px] border bg-surface p-4 text-left shadow-card";
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(className, "outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring")}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

function StockCells({ cell }: { cell: StockCell | undefined }) {
  if (!cell) {
    return (
      <>
        <TableCell className="border-l text-right text-text-500">—</TableCell>
        <TableCell className="text-right text-text-500">—</TableCell>
        <TableCell className="text-right text-text-500">—</TableCell>
        <TableCell className="text-right text-text-500">—</TableCell>
      </>
    );
  }
  return (
    <>
      <TableCell className="tabular border-l text-right">{formatNumber(cell.onHand)}</TableCell>
      <TableCell className="tabular text-right text-text-700">{formatNumber(cell.reserved)}</TableCell>
      <TableCell className="tabular text-right text-text-700">{formatNumber(cell.buffer)}</TableCell>
      <TableCell className="text-right">
        <Available
          value={cell.available}
          low={cell.minStock !== null && cell.available > 0 && cell.available <= cell.minStock}
        />
      </TableCell>
    </>
  );
}

/** Ready to sell, bold; under zero it is overselling, said in words and not only in red (8.5). */
function Available({ value, low, large }: { value: number; low?: boolean; large?: boolean }) {
  const t = useTranslations("stock");
  if (value < 0) {
    return (
      <span className="inline-flex items-center gap-1 font-semibold text-danger">
        <AlertTriangle className="size-3.5" aria-hidden />
        {t("oversold", { count: -value })}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "tabular font-bold text-text-900",
        large && "text-2xl",
        value === 0 && "text-danger",
        low && "text-warning",
      )}
    >
      {formatNumber(value)}
    </span>
  );
}

const DOT: Record<string, string> = {
  success: "bg-success",
  neutral: "bg-text-500",
  danger: "bg-danger",
  warning: "bg-warning",
};

/** "Terkirim ke": one channel icon per store with a dot for the push state, the details in a tooltip. */
function PushIcons({ push }: { push: StockRow["push"] }) {
  const t = useTranslations("stock");
  const tz = useTimeZone();
  if (push.length === 0) return <span className="text-[13px] text-text-500">{t("noListings")}</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {push.map((p) => (
        <Tooltip key={p.storeId}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="relative inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${p.storeName}: ${t(`push_${p.state}`)}`}
            >
              <ChannelIcon channel={p.channel} className="size-6 text-[11px]" />
              <span
                className={cn(
                  "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface",
                  DOT[PUSH_TONE[p.state]],
                )}
                aria-hidden
              />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            <p className="font-medium">{p.storeName}</p>
            <p>{t(`push_${p.state}`)}</p>
            {p.state === "failed" ? <p>{t("pushFailed", { count: p.failCount })}</p> : null}
            {p.lastError ? <p className="opacity-80">{p.lastError}</p> : null}
            {p.lastPushedAt ? (
              <p className="opacity-80">{t("lastPushed", { at: formatDateTime(p.lastPushedAt, tz) })}</p>
            ) : null}
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}
