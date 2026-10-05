"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { Download, PackageCheck, Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { FilterChip } from "@/components/common/filter-chip";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Segmented } from "@/components/common/segmented";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { formatNumber } from "@/lib/format";
import { useCan } from "@/lib/session";
import {
  coverTone,
  DEFAULT_COVER_DAYS,
  DEFAULT_TARGET_DAYS,
  dayCount,
  formatRate,
  MAX_LIMIT,
  nextLimit,
  PAGE,
  REASON_TONE,
  type RestockRow,
  type RestockWindow,
  restockExportHref,
  restockQuery,
  WINDOWS,
  windowOf,
} from "./restock-meta";

const ALL = "all";

function useRestockFilters() {
  const { params, set } = useUrlParams();
  return {
    window: windowOf(params.get("window")),
    coverDays: dayCount(params.get("cover"), DEFAULT_COVER_DAYS),
    targetDays: dayCount(params.get("target"), DEFAULT_TARGET_DAYS),
    warehouseId: params.get("warehouse"),
    q: params.get("q") ?? "",
    all: params.get("all") === "true",
    set,
  };
}

/**
 * Perlu Restock (FR-STK-07, backend doc 8.20; DOKUMEN-UI-UX 14.4): what to order again per SKU and warehouse,
 * from the units sold in the last 7, 14, or 30 days: days of stock left and the suggested quantity.
 */
export function RestockView() {
  const t = useTranslations("restock");
  const tCommon = useTranslations("common");
  const can = useCan();
  const f = useRestockFilters();
  const [search, setSearch] = useState(f.q);
  const { q, set } = f;

  // the search box writes the URL once the typing pauses
  useEffect(() => {
    if (search.trim() === q) return;
    const id = setTimeout(() => set({ q: search.trim() || null }), 300);
    return () => clearTimeout(id);
  }, [search, q, set]);

  const query = restockQuery(f);
  // "Muat lebih banyak" belongs to the filters it was pressed for; new filters start from the first rows
  const filterKey = JSON.stringify(query);
  const [more, setMore] = useState({ key: filterKey, limit: PAGE });
  const limit = more.key === filterKey ? more.limit : PAGE;

  const allowed = can("inventory:read");
  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
    enabled: allowed,
  });
  const list = useQuery({
    queryKey: ["inventory", "restock", query, limit],
    queryFn: () => unwrap(api.GET("/v1/inventory/restock", { params: { query: { ...query, limit } } })),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });

  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;

  const rows = list.data?.items ?? [];
  const allWarehouses = warehouses.data?.items ?? [];
  const shownTotal = list.data ? (f.all ? list.data.total : list.data.needed) : 0;
  const filtered = f.q !== "" || f.warehouseId !== null;

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description", { window: Number(f.window), cover: f.coverDays, target: f.targetDays })}
        actions={
          <Button asChild variant="secondary">
            <a href={restockExportHref(query)} download>
              <Download aria-hidden />
              {t("download")}
            </a>
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label={t("kpiNeeded")}
          value={list.data ? formatNumber(list.data.needed) : null}
          tone={list.data && list.data.needed > 0 ? "warning" : undefined}
        />
        <Kpi label={t("kpiWatched")} value={list.data ? formatNumber(list.data.total) : null} />
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
        <Segmented
          label={t("window")}
          value={f.window}
          onChange={(w: RestockWindow) => f.set({ window: w === "30" ? null : w })}
          options={WINDOWS.map((w) => ({ value: w, label: t("windowDays", { days: Number(w) }) }))}
        />
        <FilterChip active={f.all} onClick={() => f.set({ all: f.all ? null : "true" })}>
          {t("showAll")}
        </FilterChip>
        <RulesPopover
          coverDays={f.coverDays}
          targetDays={f.targetDays}
          onChange={(cover, target) =>
            f.set({
              cover: cover === DEFAULT_COVER_DAYS ? null : String(cover),
              target: target === DEFAULT_TARGET_DAYS ? null : String(target),
            })
          }
        />
      </div>

      <Card className="gap-0 py-0">
        {list.isPending ? (
          <div className="grid gap-2 p-4" aria-busy>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={PackageCheck}
            title={filtered ? t("emptyFiltered") : t("empty")}
            body={filtered ? undefined : t("emptyBody")}
          />
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader className="bg-surface-2">
                  <TableRow>
                    <TableHead className="min-w-56">{t("colProduct")}</TableHead>
                    <TableHead>{t("colWarehouse")}</TableHead>
                    <TableHead className="text-right">{t("colAvailable")}</TableHead>
                    <TableHead className="text-right">{t("colSold", { days: Number(f.window) })}</TableHead>
                    <TableHead className="text-right">{t("colRate")}</TableHead>
                    <TableHead className="text-right">{t("colCover")}</TableHead>
                    <TableHead className="text-right">{t("colMin")}</TableHead>
                    <TableHead className="text-right">{t("colSuggested")}</TableHead>
                    <TableHead>{t("colReason")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={`${r.id}|${r.warehouseId}`} className="h-[52px]">
                      <TableCell className="max-w-72">
                        <ProductCell row={r} />
                      </TableCell>
                      <TableCell className="text-text-700">{r.warehouse}</TableCell>
                      <TableCell className={cn("tabular text-right", r.available <= 0 && "text-danger")}>
                        {formatNumber(r.available)}
                      </TableCell>
                      <TableCell className="tabular text-right">{formatNumber(r.unitsSold)}</TableCell>
                      <TableCell className="tabular text-right text-text-700">{formatRate(r.dailyRate)}</TableCell>
                      <TableCell className="text-right">
                        <Cover row={r} coverDays={f.coverDays} />
                      </TableCell>
                      <TableCell className="tabular text-right text-text-700">
                        {r.minStock === null ? "—" : formatNumber(r.minStock)}
                      </TableCell>
                      <TableCell className="tabular text-right font-bold text-text-900">
                        {r.suggested > 0 ? formatNumber(r.suggested) : "—"}
                      </TableCell>
                      <TableCell>
                        <Reason row={r} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <ul className="divide-y md:hidden">
              {rows.map((r) => (
                <li key={`${r.id}|${r.warehouseId}`} className="grid gap-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <ProductCell row={r} />
                    <div className="grid shrink-0 justify-items-end">
                      <span className="tabular text-2xl font-bold text-text-900">
                        {r.suggested > 0 ? formatNumber(r.suggested) : "—"}
                      </span>
                      <span className="text-[12px] text-text-500">{t("colSuggested")}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-700">
                    <Reason row={r} />
                    <span>{r.warehouse}</span>
                    <span>
                      {t("colAvailable")} <span className="tabular">{formatNumber(r.available)}</span>
                    </span>
                    <Cover row={r} coverDays={f.coverDays} />
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-[13px] text-text-500">
              <span>{tCommon("showing", { shown: formatNumber(rows.length), total: formatNumber(shownTotal) })}</span>
              {rows.length < shownTotal ? (
                limit < MAX_LIMIT ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={list.isFetching}
                    onClick={() => setMore({ key: filterKey, limit: nextLimit(limit) })}
                  >
                    {tCommon("loadMore")}
                  </Button>
                ) : (
                  <span>{t("moreInCsv")}</span>
                )
              ) : null}
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string | null; tone?: "warning" | undefined }) {
  return (
    <div className="grid gap-1 rounded-[10px] border bg-surface p-4 shadow-card">
      <span className="text-[13px] text-text-500">{label}</span>
      {value === null ? (
        <Skeleton className="h-7 w-20" />
      ) : (
        <span className={cn("text-lg font-bold text-text-900 md:text-xl", tone === "warning" && "text-warning")}>
          {value}
        </span>
      )}
    </div>
  );
}

function ProductCell({ row }: { row: RestockRow }) {
  const title =
    row.variantName && row.variantName !== row.productName
      ? `${row.productName} · ${row.variantName}`
      : row.productName;
  return (
    <div className="grid min-w-0 gap-0.5">
      <Link
        href={`/stok?q=${encodeURIComponent(row.sku)}`}
        className="w-fit font-mono text-sm text-primary hover:underline"
      >
        {row.sku}
      </Link>
      <span className="truncate text-[13px] text-text-500" title={title}>
        {title}
      </span>
    </div>
  );
}

/** Days of stock left at the current pace, said in words; nothing sold means no pace to measure. */
function Cover({ row, coverDays }: { row: RestockRow; coverDays: number }) {
  const t = useTranslations("restock");
  const tone = coverTone(row, coverDays);
  const text =
    row.available <= 0
      ? t("coverNone")
      : row.daysOfCover === null
        ? t("coverNoSales")
        : t("coverDays", { days: formatRate(row.daysOfCover) });
  return (
    <span
      className={cn(
        "tabular whitespace-nowrap",
        tone === "danger" && "font-semibold text-danger",
        tone === "warning" && "font-semibold text-warning",
        !tone && "text-text-700",
      )}
    >
      {text}
    </span>
  );
}

function Reason({ row }: { row: RestockRow }) {
  const t = useTranslations("restock");
  if (!row.reason) return <StatusPill tone="success">{t("reason_ok")}</StatusPill>;
  return <StatusPill tone={REASON_TONE[row.reason]}>{t(`reason_${row.reason}`)}</StatusPill>;
}

/** When a row counts as running low, and how far ahead the suggestion orders. */
function RulesPopover({
  coverDays,
  targetDays,
  onChange,
}: {
  coverDays: number;
  targetDays: number;
  onChange: (cover: number, target: number) => void;
}) {
  const t = useTranslations("restock");
  const [open, setOpen] = useState(false);
  const [cover, setCover] = useState(String(coverDays));
  const [target, setTarget] = useState(String(targetDays));
  const valid = (v: string) => dayCount(v, -1) !== -1;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setCover(String(coverDays));
          setTarget(String(targetDays));
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="secondary">
          <SlidersHorizontal aria-hidden />
          {t("rules")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            // the button is disabled while a number is out of range, which also stops Enter
            onChange(Number(cover), Number(target));
            setOpen(false);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="restock-cover">{t("coverDaysLabel")}</Label>
            <Input
              id="restock-cover"
              inputMode="numeric"
              value={cover}
              onChange={(e) => setCover(e.target.value)}
              aria-invalid={!valid(cover) || undefined}
            />
            <p className="text-[13px] text-text-500">{t("coverDaysHint")}</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="restock-target">{t("targetDaysLabel")}</Label>
            <Input
              id="restock-target"
              inputMode="numeric"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-invalid={!valid(target) || undefined}
            />
            <p className="text-[13px] text-text-500">{t("targetDaysHint")}</p>
          </div>
          {!valid(cover) || !valid(target) ? (
            <p role="alert" className="text-sm text-danger">
              {t("daysProblem")}
            </p>
          ) : null}
          <Button type="submit" disabled={!valid(cover) || !valid(target)}>
            {t("applyRules")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
