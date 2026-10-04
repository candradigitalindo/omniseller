"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { Clock, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ChannelIcon } from "@/components/common/channel";
import { FilterChip } from "@/components/common/filter-chip";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { formatNumber, formatRemaining, formatRupiah } from "@/lib/format";
import { ReturnDetailSheet } from "./return-detail";
import {
  answerWindow,
  RETURN_TABS,
  RETURN_TONE,
  type ReturnItem,
  type ReturnTab,
  returnTabOf,
  windowTone,
} from "./return-meta";

const PAGE = 50;

function useReturnFilters() {
  const { params, set } = useUrlParams();
  return {
    tab: returnTabOf(params.get("tab")),
    awaiting: params.get("awaiting") === "true",
    receive: params.get("receive") === "true",
    openId: params.get("id"),
    set,
  };
}

/** Re-renders every minute, so deadlines count down while the page stays open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * L09 Retur dan Batal (DOKUMEN-UI-UX 14.2): requests from buyers and parcels coming back, with the answer
 * window each marketplace allows. Decisions are taken one request at a time, in the side panel.
 */
export function ReturnsView() {
  const t = useTranslations("returns");
  const tCommon = useTranslations("common");
  const f = useReturnFilters();
  const now = useNow();

  const summary = useQuery({
    queryKey: ["returns", "summary"],
    queryFn: () => unwrap(api.GET("/v1/returns/summary")),
    refetchInterval: 60_000,
  });
  const query = {
    group: f.tab,
    ...(f.awaiting ? { awaitingDecision: "true" as const } : {}),
    ...(f.receive ? { toReceive: "true" as const } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: ["returns", "list", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/returns", {
          params: { query: { ...query, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const s = summary.data;
  const tabCount: Record<ReturnTab, number | null> = {
    returns: null,
    cancellations: s?.cancellations ?? null,
    rto: s?.rto ?? null,
  };

  return (
    <>
      <PageHeader title={t("title")} description={t("subtitle")} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label={t("kpiAwaiting")}
          value={s?.awaitingDecision}
          onClick={() => f.set({ awaiting: f.awaiting ? null : "true" })}
        />
        <Tile label={t("kpiDueSoon")} value={s?.dueSoon} tone="danger" onClick={() => f.set({ awaiting: "true" })} />
        <Tile
          label={t("kpiToReceive")}
          value={s?.toReceive}
          onClick={() => f.set({ receive: f.receive ? null : "true" })}
        />
        <Tile label={t("kpiFailed")} value={s?.failedResponses} tone="danger" />
      </div>

      <div className="-mx-4 mb-3 overflow-x-auto border-b px-4 md:mx-0 md:px-0" role="tablist" aria-label={t("tabs")}>
        <div className="flex min-w-max gap-1">
          {RETURN_TABS.map((tab) => {
            const active = f.tab === tab;
            const count = tabCount[tab];
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => f.set({ tab: tab === "returns" ? null : tab })}
                className={cn(
                  "-mb-px flex h-11 items-center gap-1.5 border-b-2 border-transparent px-3 text-[15px] font-medium text-text-700 outline-none hover:text-text-900 focus-visible:ring-2 focus-visible:ring-ring",
                  active && "border-primary text-primary-600",
                )}
              >
                {t(`tab_${tab}`)}
                {count ? (
                  <span className="tabular rounded-full bg-surface-2 px-1.5 text-[13px] text-text-700">
                    {formatNumber(count)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* one row that scrolls sideways on phones */}
      <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        {f.tab !== "rto" ? (
          <FilterChip active={f.awaiting} onClick={() => f.set({ awaiting: f.awaiting ? null : "true" })}>
            {t("filterAwaiting")}
          </FilterChip>
        ) : null}
        {f.tab !== "cancellations" ? (
          <FilterChip active={f.receive} onClick={() => f.set({ receive: f.receive ? null : "true" })}>
            {t("filterToReceive")}
          </FilterChip>
        ) : null}
      </div>

      <Card className="gap-0 py-0">
        {list.isPending ? (
          <div className="grid gap-2 p-4" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Undo2} title={t(`empty_${f.tab}`)} body={t("emptyBody")} />
        ) : (
          <>
            <Table className="hidden md:table">
              <TableHeader className="bg-surface-2">
                <TableRow>
                  <TableHead>{t("colOrder")}</TableHead>
                  <TableHead>{t("colKind")}</TableHead>
                  <TableHead>{t("colReason")}</TableHead>
                  <TableHead className="text-right">{t("colAmount")}</TableHead>
                  <TableHead>{t("colDeadline")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="h-[52px] cursor-pointer" onClick={() => f.set({ id: r.id })}>
                    <TableCell>
                      <div className="grid gap-0.5">
                        <span className="font-mono text-sm font-medium text-text-900">{r.externalOrderId ?? "—"}</span>
                        <span className="flex items-center gap-1.5 text-[13px] text-text-500">
                          {r.store ? <ChannelIcon channel={r.store.channel} /> : null}
                          {r.store?.name}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>{t(`kind_${r.kind}`)}</TableCell>
                    <TableCell className="max-w-64">
                      <span className="line-clamp-2 text-sm" title={r.reason ?? undefined}>
                        {r.reason ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {r.refundAmount === null ? "—" : formatRupiah(r.refundAmount)}
                    </TableCell>
                    <TableCell>
                      <Deadline row={r} now={now} />
                    </TableCell>
                    <TableCell>
                      <ReturnStatus row={r} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <ul className="divide-y md:hidden">
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="grid w-full gap-1 p-4 text-left"
                    onClick={() => f.set({ id: r.id })}
                    aria-label={t("openReturn", { number: r.externalOrderId ?? r.id })}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-sm font-medium text-text-900">
                        {r.externalOrderId ?? "—"}
                      </span>
                      <ReturnStatus row={r} />
                    </span>
                    <span className="text-sm text-text-700">
                      {t(`kind_${r.kind}`)}
                      {r.reason ? ` · ${r.reason}` : ""}
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span className="tabular text-sm font-semibold text-text-900">
                        {r.refundAmount === null ? "" : formatRupiah(r.refundAmount)}
                      </span>
                      <Deadline row={r} now={now} />
                    </span>
                    <span className="flex items-center gap-1.5 text-[13px] text-text-500">
                      {r.store ? <ChannelIcon channel={r.store.channel} /> : null}
                      {r.store?.name}
                    </span>
                  </button>
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

      <ReturnDetailSheet returnId={f.openId} onClose={() => f.set({ id: null })} />
    </>
  );
}

function Tile({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: number | undefined;
  tone?: "danger";
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="text-[13px] text-text-500">{label}</span>
      {value === undefined ? (
        <Skeleton className="h-7 w-12" />
      ) : (
        <span
          className={cn("tabular text-xl font-bold text-text-900", tone === "danger" && value > 0 && "text-danger")}
        >
          {formatNumber(value)}
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

/** Answer window as a countdown pill; nothing when no answer is awaited. */
export function Deadline({ row, now }: { row: Pick<ReturnItem, "respondByAt" | "awaitingDecision">; now: number }) {
  const ms = answerWindow(row, now);
  if (ms === null) return <span className="text-text-500">—</span>;
  return (
    <StatusPill tone={windowTone(ms)} icon={Clock}>
      {formatRemaining(ms)}
    </StatusPill>
  );
}

/** Status pill, plus where the seller's answer is (on its way or refused by the marketplace). */
export function ReturnStatus({ row }: { row: Pick<ReturnItem, "status" | "response" | "awaitingDecision"> }) {
  const t = useTranslations("returns");
  return (
    <span className="flex flex-wrap items-center gap-1">
      <StatusPill tone={RETURN_TONE[row.status]}>{t(`status_${row.status}`)}</StatusPill>
      {row.response?.status === "pending" ? <StatusPill tone="info">{t("responseSending")}</StatusPill> : null}
      {row.response?.status === "failed" ? <StatusPill tone="danger">{t("responseFailed")}</StatusPill> : null}
      {row.awaitingDecision && row.response?.status !== "failed" ? (
        <StatusPill tone="warning">{t("awaitingYou")}</StatusPill>
      ) : null}
    </span>
  );
}
