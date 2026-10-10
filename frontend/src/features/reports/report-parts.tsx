"use client";

import { cn } from "cn";
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatRupiah } from "@/lib/format";
import {
  customProblem,
  formatPercent,
  HEAT_LEVELS,
  type HeatCell,
  HOURS,
  heatGrid,
  heatLevel,
  type SalesReport,
  weekdayOf,
} from "./report-meta";

export interface BarRow {
  key: string;
  label: ReactNode;
  /** the bar's color: the entity's chart slot, so a channel keeps its color everywhere (13.2) */
  color: string;
  value: number;
  share: number;
}

/**
 * Categories compared (DOKUMEN-UI-UX 13.1): slim horizontal bars from one baseline, largest first, square at
 * the baseline and rounded 4 px at the data end, the value at the tip in text color.
 */
export function ShareBars({ rows }: { rows: BarRow[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  return (
    <ul className="grid gap-4">
      {rows.map((r) => (
        <li key={r.key} className="grid gap-1.5 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:items-center md:gap-4">
          <div className="flex min-w-0 items-center gap-2 text-sm text-text-900">{r.label}</div>
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="h-2.5 shrink-0 rounded-r-[4px]"
              style={{
                width: `calc((100% - 11rem) * ${max > 0 ? Math.max(r.value / max, 0.01) : 0})`,
                backgroundColor: r.color,
              }}
            />
            <span className="text-sm whitespace-nowrap text-text-900">
              {formatRupiah(r.value)} <span className="text-text-500">· {formatPercent(r.share)}</span>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface RankColumn<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
}

/**
 * A ranked list (per product, category, province): the name with a thin bar of the ranking measure, then the
 * figures. A table from tablets up; on phones each row is a short card (6.3).
 */
export function RankTable<T>({
  rows,
  rowKey,
  nameHeader,
  name,
  measure,
  columns,
  scrollLabel,
}: {
  rows: readonly T[];
  rowKey: (row: T) => string;
  nameHeader: string;
  name: (row: T) => ReactNode;
  /** what the bar under the name shows */
  measure: (row: T) => number;
  columns: RankColumn<T>[];
  /** names the table's scroll region when its columns may not fit (see `Table`) */
  scrollLabel?: string | undefined;
}) {
  const max = rows.reduce((m, r) => Math.max(m, measure(r)), 0);
  const bar = (r: T) => (
    <span
      aria-hidden
      className="block h-1.5 rounded-r-[4px] bg-chart-1"
      style={{ width: `${max > 0 ? Math.max((measure(r) / max) * 100, 1) : 0}%` }}
    />
  );
  return (
    <>
      <div className="hidden md:block">
        <Table scrollLabel={scrollLabel}>
          <TableHeader className="bg-surface-2">
            <TableRow>
              <TableHead className="w-[45%]">{nameHeader}</TableHead>
              {columns.map((c) => (
                <TableHead key={c.key} className="text-right">
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={rowKey(r)}>
                <TableCell className="max-w-0">
                  <div className="grid gap-1.5">
                    <div className="min-w-0 truncate">{name(r)}</div>
                    {bar(r)}
                  </div>
                </TableCell>
                {columns.map((c) => (
                  <TableCell key={c.key} className="tabular text-right">
                    {c.cell(r)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="grid gap-4 md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="grid gap-1.5">
            <div className="min-w-0">{name(r)}</div>
            {bar(r)}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-text-700">
              {columns.map((c) => (
                <span key={c.key}>
                  <span className="text-text-500">{c.header}</span> <span className="tabular">{c.cell(r)}</span>
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** "20.00–20.59" */
export function hourRange(hour: number): string {
  const h = String(hour).padStart(2, "0");
  return `${h}.00–${h}.59`;
}

/**
 * When orders come (L30 "Per jam"): weekdays by hours, each cell a step of the sequential sea-blue scale by
 * its orders against the busiest hour, 2 px of card between cells, no numbers in the cells. Hovering a cell
 * writes its figures under the map; the table view lists them for keyboards and screen readers.
 */
export function HourHeatmap({ byHour }: { byHour: SalesReport["byHour"] }) {
  const t = useTranslations("reports");
  const [hover, setHover] = useState<HeatCell | null>(null);
  const grid = heatGrid(byHour);
  const max = byHour.reduce((m, c) => Math.max(m, c.orders), 0);
  const busiest = byHour.reduce<SalesReport["byHour"][number] | null>(
    (b, c) => (!b || c.orders > b.orders ? c : b),
    null,
  );
  const summary = busiest
    ? t("heatSummary", {
        weekday: t(`weekday_${weekdayOf(busiest.weekday)}`),
        hour: String(busiest.hour).padStart(2, "0"),
        orders: busiest.orders,
      })
    : t("heatEmpty");

  return (
    <div className="grid gap-3">
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div
          role="img"
          aria-label={summary}
          // one handler for all 168 cells: the cell under the pointer names itself in data attributes
          onMouseMove={(e) => {
            const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-hour]");
            const found = cell ? grid[Number(cell.dataset.weekday) - 1]?.[Number(cell.dataset.hour)] : undefined;
            setHover(found ?? null);
          }}
          onMouseLeave={() => setHover(null)}
          className="grid min-w-[600px] grid-cols-[2.75rem_repeat(24,minmax(0,1fr))] gap-[2px]"
        >
          <span />
          {HOURS.map((h) => (
            <span key={h} aria-hidden className="pb-1 text-center text-[11px] text-text-500">
              {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
            </span>
          ))}
          {grid.map((row) => (
            <Fragment key={row[0]?.weekday}>
              <span aria-hidden className="self-center text-[13px] text-text-700">
                {t(`weekdayShort_${weekdayOf(row[0]?.weekday ?? 1)}`)}
              </span>
              {row.map((c) => {
                const level = heatLevel(c.orders, max);
                return (
                  <span
                    key={c.hour}
                    data-weekday={c.weekday}
                    data-hour={c.hour}
                    data-level={level}
                    className={cn("h-7 rounded-[3px]", level === 0 && "bg-surface-2 ring-1 ring-border ring-inset")}
                    style={level > 0 ? { backgroundColor: `var(--seq-${level})` } : undefined}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
        <p className="min-h-5 text-text-700">
          {hover
            ? t("heatReadout", {
                weekday: t(`weekday_${weekdayOf(hover.weekday)}`),
                hours: hourRange(hover.hour),
                orders: hover.orders,
                revenue: formatRupiah(hover.revenue),
              })
            : byHour.length === 0
              ? t("heatEmpty")
              : t("heatHint")}
        </p>
        <span className="flex items-center gap-1.5 text-text-500">
          {t("heatFew")}
          <span className="flex gap-[2px]" aria-hidden>
            {HEAT_LEVELS.map((level) => (
              <span key={level} className="size-3 rounded-[2px]" style={{ backgroundColor: `var(--seq-${level})` }} />
            ))}
          </span>
          {t("heatMany")}
        </span>
      </div>
    </div>
  );
}

/** The busy-time map as a table: every hour that sold, busiest first. */
export function HourTable({ byHour }: { byHour: SalesReport["byHour"] }) {
  const t = useTranslations("reports");
  const rows = [...byHour]
    .filter((c) => c.orders > 0)
    .sort((a, b) => b.orders - a.orders || b.revenue - a.revenue || a.weekday - b.weekday || a.hour - b.hour);
  if (rows.length === 0) return <p className="py-6 text-center text-text-500">{t("heatEmpty")}</p>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader className="bg-surface-2">
          <TableRow>
            <TableHead>{t("colDay")}</TableHead>
            <TableHead>{t("colHour")}</TableHead>
            <TableHead className="text-right">{t("colOrders")}</TableHead>
            <TableHead className="text-right">{t("colRevenue")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={`${c.weekday}|${c.hour}`}>
              <TableCell>{t(`weekday_${weekdayOf(c.weekday)}`)}</TableCell>
              <TableCell className="tabular">{hourRange(c.hour)}</TableCell>
              <TableCell className="tabular text-right">{formatNumber(c.orders)}</TableCell>
              <TableCell className="tabular text-right">{formatRupiah(c.revenue)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** "Kustom": two dates and "Terapkan"; the period is checked as the api does (366 days at most). */
export function CustomPeriod({
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
