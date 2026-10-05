"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, LineChart, Table2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { ChannelIcon, channelChartSlot, channelLabel } from "@/components/common/channel";
import { KpiTile } from "@/components/common/kpi";
import { EmptyState, ErrorState, PageHeader } from "@/components/common/page";
import { Segmented } from "@/components/common/segmented";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStores } from "@/features/stores/use-store-modes";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime, formatNumber, formatRupiah } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import {
  bucketLabel,
  channelOf,
  customProblem,
  exportHref,
  formatLocalDate,
  formatPercent,
  formatPointChange,
  formatRange,
  GRANULARITIES,
  type Granularity,
  granularityOf,
  isRunning,
  PERIODS,
  type Period,
  periodOf,
  periodRange,
  type ReportQuery,
  reportQuery,
  type SalesReport,
  type Section,
  type TrendPoint,
  todayIn,
  trendPoints,
} from "./report-meta";
import { type BarRow, HourHeatmap, HourTable, RankTable, ShareBars } from "./report-parts";
import type { TrendData } from "./trend-chart";

const TrendChart = dynamic(() => import("./trend-chart").then((m) => m.TrendChart), {
  ssr: false,
  loading: () => <Skeleton className="h-72 w-full" />,
});

const TABS = ["channels", "stores", "products", "categories", "regions", "hours"] as const;
type Tab = (typeof TABS)[number];
const tabOf = (value: string | null): Tab => TABS.find((x) => x === value) ?? "channels";
const CHARTED = new Set<Tab>(["channels", "stores", "hours"]);
const SECTIONS = ["series", ...TABS] as const satisfies readonly Section[];
const ALL = "all";

/** "1,2 jt", "450 rb": the axis carries round numbers, the tooltip and table the exact ones. */
function compactRupiah(v: number): string {
  if (v >= 1_000_000) return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(v / 1_000_000)} jt`;
  if (v >= 1000) return `${Math.round(v / 1000)} rb`;
  return formatNumber(v);
}

function useReportFilters() {
  const { params, set } = useUrlParams();
  const storeId = params.get("store");
  return {
    period: periodOf(params.get("period")),
    custom: { from: params.get("from") ?? "", to: params.get("to") ?? "" },
    granularity: granularityOf(params.get("granularity")),
    storeId,
    // a store narrows more than its channel; reportQuery and the scope select both prefer it
    channel: channelOf(params.get("channel")),
    compare: params.get("compare") !== "false",
    tab: tabOf(params.get("tab")),
    set,
  };
}

/**
 * L30 Laporan Penjualan (DOKUMEN-UI-UX 14.6, backend 8.20): the period against the one before, the trend, and
 * sales per channel, store, product, category, province, and hour. Sales are paid orders that were not
 * cancelled, counted by order time in the business's time zone (PRD 13.2), the same as the dashboard.
 */
export function SalesReportView() {
  const t = useTranslations("reports");
  const can = useCan();
  const tz = useTimeZone();
  const f = useReportFilters();
  const today = todayIn(tz);
  const range = periodRange(f.period, today, f.custom);
  const query = range
    ? reportQuery({ range, granularity: f.granularity, storeId: f.storeId, channel: f.channel, compare: f.compare })
    : null;
  const allowed = can("report:read");

  const report = useQuery({
    queryKey: ["reports", "sales", query],
    queryFn: () => unwrap(api.GET("/v1/reports/sales", { params: { query: query ?? {} } })),
    enabled: allowed && query !== null,
    placeholderData: keepPreviousData,
  });

  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;

  const choosePeriod = (p: Period) => {
    if (p === "custom") {
      // start from the dates on screen, so only the ends need changing
      const from = range?.from ?? today;
      f.set({ period: p, from, to: range?.to ?? today });
    } else f.set({ period: p === "month" ? null : p, from: null, to: null });
  };

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={query ? <DownloadMenu query={query} /> : null}
      />

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="-mx-4 w-[calc(100%+2rem)] overflow-x-auto px-4 md:mx-0 md:w-auto md:px-0">
          <Segmented
            label={t("period")}
            value={f.period}
            onChange={choosePeriod}
            options={PERIODS.map((p) => ({ value: p, label: t(`period_${p}`) }))}
          />
        </div>
        <ScopeSelect storeId={f.storeId} channel={f.channel} onChange={(patch) => f.set(patch)} />
        <Segmented
          label={t("granularity")}
          value={f.granularity}
          onChange={(g: Granularity) => f.set({ granularity: g === "day" ? null : g })}
          options={GRANULARITIES.map((g) => ({ value: g, label: t(`granularity_${g}`) }))}
        />
        <div className="flex items-center gap-2">
          <Switch
            id="report-compare"
            checked={f.compare}
            onCheckedChange={(on) => f.set({ compare: on ? null : "false" })}
          />
          <Label htmlFor="report-compare" className="font-normal">
            {t("compare")}
          </Label>
        </div>
      </div>

      {f.period === "custom" ? (
        <CustomPeriod
          key={`${f.custom.from}|${f.custom.to}`}
          initial={f.custom}
          onApply={(r) => f.set({ period: "custom", from: r.from, to: r.to })}
        />
      ) : null}

      {!query ? (
        <Card>
          <EmptyState title={t("pickDates")} />
        </Card>
      ) : report.isPending ? (
        <ReportSkeleton />
      ) : report.isError ? (
        <Card>
          <ErrorState error={report.error} onRetry={() => report.refetch()} />
        </Card>
      ) : (
        <ReportBody
          report={report.data}
          query={query}
          today={today}
          timeZone={tz}
          tab={f.tab}
          onTab={(tab) => f.set({ tab: tab === "channels" ? null : tab })}
        />
      )}
    </>
  );
}

function ReportSkeleton() {
  return (
    <div className="grid gap-4" aria-busy>
      <Skeleton className="h-5 w-72" />
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}

/** Every part of the report as CSV with the same filters (L30 "Unduh laporan"). */
function DownloadMenu({ query }: { query: ReportQuery }) {
  const t = useTranslations("reports");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary">
          <Download aria-hidden />
          {t("downloadReport")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SECTIONS.map((s) => (
          <DropdownMenuItem key={s} asChild>
            <a href={exportHref(s, query)} download>
              {t(`section_${s}`)}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** All stores, all stores of one channel (when it has several), or one store. */
function ScopeSelect({
  storeId,
  channel,
  onChange,
}: {
  storeId: string | null;
  channel: string | null;
  onChange: (patch: { store: string | null; channel: string | null }) => void;
}) {
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");
  const { byId } = useStores();
  const stores = [...byId.values()];
  const channels = [...new Set(stores.map((s) => s.channel))].filter(
    (c) => stores.filter((s) => s.channel === c).length > 1,
  );
  if (stores.length < 2) return null;
  const value = storeId ? `store:${storeId}` : channel ? `channel:${channel}` : ALL;
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        const [kind, id] = v.split(":");
        onChange({ store: kind === "store" ? (id ?? null) : null, channel: kind === "channel" ? (id ?? null) : null });
      }}
    >
      <SelectTrigger className="h-10 w-56" aria-label={t("scope")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{tCommon("allStores")}</SelectItem>
        {channels.map((c) => (
          <SelectItem key={c} value={`channel:${c}`}>
            {t("channelAll", { channel: channelLabel(c) })}
          </SelectItem>
        ))}
        {stores.map((s) => (
          <SelectItem key={s.id} value={`store:${s.id}`}>
            <ChannelIcon channel={s.channel} decorative />
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CustomPeriod({
  initial,
  onApply,
}: {
  initial: { from: string; to: string };
  onApply: (range: { from: string; to: string }) => void;
}) {
  const t = useTranslations("reports");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [problem, setProblem] = useState<ReturnType<typeof customProblem>>(null);
  return (
    <form
      className="mb-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const p = customProblem(from, to);
        setProblem(p);
        if (!p) onApply({ from, to });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="report-from">{t("from")}</Label>
        <Input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="report-to">{t("to")}</Label>
        <Input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />
      </div>
      <Button type="submit" variant="secondary">
        {t("apply")}
      </Button>
      {problem ? (
        <p role="alert" className="w-full text-sm text-danger">
          {t(`customProblem_${problem}`)}
        </p>
      ) : null}
    </form>
  );
}

function ReportBody({
  report,
  query,
  today,
  timeZone,
  tab,
  onTab,
}: {
  report: SalesReport;
  query: ReportQuery;
  today: string;
  timeZone: string;
  tab: Tab;
  onTab: (tab: Tab) => void;
}) {
  const t = useTranslations("reports");
  const [asTable, setAsTable] = useState(false);
  const s = report.summary;
  const running = isRunning(report, today);
  const versus = t("versus");
  const until = (at: string) => (running ? ` ${t("until", { time: formatDateTime(at, timeZone) })}` : "");
  const current = `${formatRange(report.range)}${until(report.period.to)}`;
  const previous =
    report.previousRange && report.previousPeriod
      ? `${formatRange(report.previousRange)}${until(report.previousPeriod.to)}`
      : null;

  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-text-500">
        {previous ? t("captionCompare", { current, previous }) : t("caption", { current })}
      </p>

      {/* full rupiah amounts do not fit two tiles side by side on small phones */}
      <section aria-label={t("kpis")} className="grid gap-3 min-[440px]:grid-cols-2 md:gap-4 lg:grid-cols-4">
        <KpiTile
          label={t("kpiRevenue")}
          value={formatRupiah(s.revenue)}
          change={s.change ? { pct: s.change.revenue, versus } : undefined}
        />
        <KpiTile
          label={t("kpiOrders")}
          value={formatNumber(s.orders)}
          change={s.change ? { pct: s.change.orders, versus } : undefined}
        />
        <KpiTile
          label={t("kpiAov")}
          value={formatRupiah(s.averageOrderValue)}
          change={s.change ? { pct: s.change.averageOrderValue, versus } : undefined}
        />
        <KpiTile
          label={t("kpiCancel")}
          value={s.cancellationRate === null ? "—" : formatPercent(s.cancellationRate)}
          change={
            s.change && s.change.cancellationRate !== null
              ? {
                  pct: s.change.cancellationRate,
                  versus,
                  text: formatPointChange(s.change.cancellationRate),
                  invert: true,
                }
              : undefined
          }
          note={
            s.paidOrders > 0 ? t("cancelNote", { cancelled: s.cancelledOrders, paid: s.paidOrders }) : t("noPaidOrders")
          }
        />
      </section>
      <p className="text-[13px] text-text-700">
        {t("extra", { units: s.units, shipped: s.shippedOrders, shippedRevenue: formatRupiah(s.shippedRevenue) })}
      </p>

      <TrendCard report={report} query={query} today={today} />

      <Card className="gap-0 py-0">
        <Tabs value={tab} onValueChange={(v) => onTab(tabOf(v))}>
          <div className="flex flex-wrap items-center justify-between gap-x-2 border-b px-4">
            <TabsList variant="line" className="-mb-px max-w-full justify-start overflow-x-auto" aria-label={t("tabs")}>
              {TABS.map((x) => (
                <TabsTrigger key={x} value={x} className="flex-none px-3 text-[15px]">
                  {t(`section_${x}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            {/* bars and the busy-time map have a table view; the ranked lists are tables already */}
            <CardTools
              asTable={CHARTED.has(tab) ? asTable : null}
              onToggle={() => setAsTable((v) => !v)}
              section={tab}
              query={query}
            />
          </div>
          {TABS.map((x) => (
            <TabsContent key={x} value={x} className="p-4">
              <Breakdown tab={x} report={report} asTable={asTable} />
            </TabsContent>
          ))}
        </Tabs>
      </Card>
    </div>
  );
}

function CardTools({
  asTable,
  onToggle,
  section,
  query,
}: {
  asTable: boolean | null;
  onToggle?: () => void;
  section: Section;
  query: ReportQuery;
}) {
  const t = useTranslations("reports");
  return (
    <div className="ml-auto flex flex-wrap items-center gap-1">
      {asTable !== null && onToggle ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggle}
          aria-label={t(asTable ? "showChartOf" : "showTableOf", { section: t(`section_${section}`) })}
        >
          {asTable ? <LineChart aria-hidden /> : <Table2 aria-hidden />}
          {asTable ? t("showChart") : t("showTable")}
        </Button>
      ) : null}
      <Button asChild variant="ghost" size="sm">
        <a
          href={exportHref(section, query)}
          download
          aria-label={t("downloadSection", { section: t(`section_${section}`) })}
        >
          <Download aria-hidden />
          {t("download")}
        </a>
      </Button>
    </div>
  );
}

function TrendCard({ report, query, today }: { report: SalesReport; query: ReportQuery; today: string }) {
  const t = useTranslations("reports");
  const [metric, setMetric] = useState<"revenue" | "orders">("revenue");
  const [asTable, setAsTable] = useState(false);
  const g = report.granularity;
  const points = trendPoints(report, today);
  const title = (bucket: string) =>
    g === "week"
      ? t("weekOf", { date: formatLocalDate(bucket) })
      : g === "month"
        ? bucketLabel(bucket, g)
        : formatLocalDate(bucket);
  const value = (p: TrendPoint) => (metric === "revenue" ? p.revenue : p.orders);
  const before = (p: TrendPoint) => (metric === "revenue" ? p.previousRevenue : p.previousOrders);
  const format = metric === "revenue" ? formatRupiah : formatNumber;
  const data: TrendData = {
    labels: points.map((p) => bucketLabel(p.bucket, g)),
    tooltipLabels: points.map((p) => ({
      current: title(p.bucket),
      previous: p.previousBucket ? title(p.previousBucket) : null,
    })),
    current: points.map(value),
    previous: report.previousRange ? points.map(before) : null,
    names: { current: t("seriesCurrent"), previous: t("seriesPrevious") },
    format,
    axisFormat: metric === "revenue" ? compactRupiah : formatNumber,
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(`trendTitle_${g}`)}</CardTitle>
        <CardAction>
          <CardTools asTable={asTable} onToggle={() => setAsTable((v) => !v)} section="series" query={query} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Segmented
          label={t("metric")}
          value={metric}
          onChange={setMetric}
          options={[
            { value: "revenue", label: t("metric_revenue") },
            { value: "orders", label: t("metric_orders") },
          ]}
        />
        {asTable ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-surface-2">
                <TableRow>
                  <TableHead>{t("colPeriod")}</TableHead>
                  <TableHead className="text-right">{t("colRevenue")}</TableHead>
                  <TableHead className="text-right">{t("colOrders")}</TableHead>
                  {report.previousRange ? (
                    <>
                      <TableHead className="border-l">{t("colPrevious")}</TableHead>
                      <TableHead className="text-right">{t("colRevenue")}</TableHead>
                      <TableHead className="text-right">{t("colOrders")}</TableHead>
                    </>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {points.map((p) => (
                  <TableRow key={p.bucket}>
                    <TableCell>{title(p.bucket)}</TableCell>
                    <TableCell className="tabular text-right">{formatRupiah(p.revenue)}</TableCell>
                    <TableCell className="tabular text-right">{formatNumber(p.orders)}</TableCell>
                    {report.previousRange ? (
                      <>
                        <TableCell className="border-l">{p.previousBucket ? title(p.previousBucket) : "—"}</TableCell>
                        <TableCell className="tabular text-right">
                          {p.previousRevenue === null ? "—" : formatRupiah(p.previousRevenue)}
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {p.previousOrders === null ? "—" : formatNumber(p.previousOrders)}
                        </TableCell>
                      </>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : points.length < 2 ? (
          <p className="py-10 text-center text-text-500">{t("oneBucket")}</p>
        ) : (
          <TrendChart data={data} />
        )}
      </CardContent>
    </Card>
  );
}

function Breakdown({ tab, report, asTable }: { tab: Tab; report: SalesReport; asTable: boolean }) {
  const t = useTranslations("reports");
  const empty = <p className="py-8 text-center text-text-500">{t("empty")}</p>;

  let body: ReactNode;
  if (tab === "hours") {
    body = asTable ? <HourTable byHour={report.byHour} /> : <HourHeatmap byHour={report.byHour} />;
  } else if (tab === "channels" || tab === "stores") {
    const rows: (BarRow & { orders: number; channel: string; name: string })[] =
      tab === "channels"
        ? report.byChannel.map((c) => ({
            key: c.channel,
            channel: c.channel,
            name: c.displayName,
            orders: c.orders,
            value: c.revenue,
            share: c.share,
            color: `var(--chart-${channelChartSlot(c.channel)})`,
            label: null,
          }))
        : report.byStore.map((c) => ({
            key: c.storeId,
            channel: c.channel,
            name: c.name,
            orders: c.orders,
            value: c.revenue,
            share: c.share,
            color: `var(--chart-${channelChartSlot(c.channel)})`,
            label: null,
          }));
    const labelled = rows.map((r) => ({
      ...r,
      label: (
        <>
          <ChannelIcon channel={r.channel} decorative />
          <span className="truncate">{r.name}</span>
          <span className="shrink-0 text-text-500">· {t("ordersCount", { count: r.orders })}</span>
        </>
      ),
    }));
    body =
      rows.length === 0 ? (
        empty
      ) : asTable ? (
        <RankTable
          rows={labelled}
          rowKey={(r) => r.key}
          nameHeader={t(tab === "channels" ? "colChannel" : "colStore")}
          name={(r) => (
            <span className="flex items-center gap-2">
              <ChannelIcon channel={r.channel} decorative />
              {r.name}
            </span>
          )}
          measure={(r) => r.value}
          columns={[
            { key: "orders", header: t("colOrders"), cell: (r) => formatNumber(r.orders) },
            { key: "revenue", header: t("colRevenue"), cell: (r) => formatRupiah(r.value) },
            { key: "share", header: t("colShare"), cell: (r) => formatPercent(r.share) },
          ]}
        />
      ) : (
        <ShareBars rows={labelled} />
      );
  } else if (tab === "products") {
    body =
      report.byProduct.length === 0 ? (
        empty
      ) : (
        <RankTable
          rows={report.byProduct}
          rowKey={(r) => `${r.variantId ?? ""}|${r.sku}`}
          nameHeader={t("colProduct")}
          name={(r) => (
            <span className="grid min-w-0">
              <span className="truncate text-text-900" title={r.name}>
                {r.name}
                {r.variantName && r.variantName !== r.name ? (
                  <span className="text-text-500"> · {r.variantName}</span>
                ) : null}
              </span>
              <span className="truncate font-mono text-[13px] text-text-500">
                {r.sku}
                {r.variantId === null ? <span className="font-sans text-warning"> · {t("unmapped")}</span> : null}
              </span>
            </span>
          )}
          measure={(r) => r.units}
          columns={[
            { key: "units", header: t("colUnits"), cell: (r) => formatNumber(r.units) },
            { key: "orders", header: t("colOrders"), cell: (r) => formatNumber(r.orders) },
            { key: "revenue", header: t("colRevenue"), cell: (r) => formatRupiah(r.revenue) },
          ]}
        />
      );
  } else if (tab === "categories") {
    body =
      report.byCategory.length === 0 ? (
        empty
      ) : (
        <RankTable
          rows={report.byCategory}
          rowKey={(r) => r.category ?? ""}
          nameHeader={t("colCategory")}
          name={(r) => <span className="truncate">{r.category ?? t("noCategory")}</span>}
          measure={(r) => r.revenue}
          columns={[
            { key: "units", header: t("colUnits"), cell: (r) => formatNumber(r.units) },
            { key: "orders", header: t("colOrders"), cell: (r) => formatNumber(r.orders) },
            { key: "revenue", header: t("colRevenue"), cell: (r) => formatRupiah(r.revenue) },
          ]}
        />
      );
  } else {
    body =
      report.byRegion.length === 0 ? (
        empty
      ) : (
        <RankTable
          rows={report.byRegion}
          rowKey={(r) => r.province ?? ""}
          nameHeader={t("colProvince")}
          name={(r) => <span className="truncate">{r.province ?? t("noProvince")}</span>}
          measure={(r) => r.revenue}
          columns={[
            { key: "orders", header: t("colOrders"), cell: (r) => formatNumber(r.orders) },
            { key: "revenue", header: t("colRevenue"), cell: (r) => formatRupiah(r.revenue) },
            { key: "share", header: t("colShare"), cell: (r) => formatPercent(r.share) },
          ]}
        />
      );
  }

  return (
    <>
      {tab === "products" ? <p className="mb-4 text-[13px] text-text-500">{t("productsNote")}</p> : null}
      {body}
    </>
  );
}
