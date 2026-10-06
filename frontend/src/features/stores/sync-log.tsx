"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, ScrollText } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useState } from "react";
import { EmptyState, ErrorState, StatusPill } from "@/components/common/page";
import { Segmented } from "@/components/common/segmented";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useTimeZone } from "@/lib/session";
import {
  callsOf,
  durationText,
  LOG_FILTERS,
  logFilterOf,
  partialFailures,
  SYNC_TONE,
  type SyncJob,
  syncKindKey,
} from "./store-admin-meta";

const PAGE = 50;
const ALL = "all";

/**
 * "Log sinkron" (FR-INT-06, L40): every piece of work against the marketplace, newest first, with its
 * outcome in the seller's words and, on request, the calls it made (secrets already masked by the api).
 * The filter asks the api, so "Gagal" lists every failure, not only the loaded ones.
 */
export function SyncLog({ storeId }: { storeId: string }) {
  const t = useTranslations("syncLog");
  const tCommon = useTranslations("common");
  const tz = useTimeZone();
  const { params, set } = useUrlParams();
  const status = logFilterOf(params.get("status"));
  const [open, setOpen] = useState<string | null>(null);
  const log = useInfiniteQuery({
    queryKey: ["stores", storeId, "sync-jobs", status],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/stores/{id}/sync-jobs", {
          params: {
            path: { id: storeId },
            query: { limit: PAGE, ...(status ? { status } : {}), ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
  // work that went through but was refused in part, else nothing to say
  const note = (j: SyncJob) => {
    const partial = partialFailures(j);
    if (!partial) return "—";
    return partial.reason
      ? t("partlyRefused", { count: partial.count, reason: partial.reason })
      : t("partlyRefusedPlain", { count: partial.count });
  };
  const kind = (j: SyncJob) => {
    const key = syncKindKey(j.kind);
    return key ? t(`kind_${key}`) : j.kind;
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={status ?? ALL}
          options={[
            { value: ALL, label: t("filterAll") },
            ...LOG_FILTERS.map((f) => ({ value: f, label: t(`filter_${f}`) })),
          ]}
          onChange={(v) => set({ status: v === ALL ? null : v })}
          label={t("filter")}
        />
        <Button size="sm" variant="ghost" loading={log.isRefetching} onClick={() => log.refetch()}>
          {t("refresh")}
        </Button>
      </div>
      <Card className="gap-0 py-0">
        {log.isPending ? (
          <div className="grid gap-2 p-4" aria-busy>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : log.isError ? (
          <ErrorState error={log.error} onRetry={() => log.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={ScrollText} title={status ? t(`empty_${status}`) : t("empty")} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-surface-2">
                  <TableRow>
                    <TableHead>{t("colTime")}</TableHead>
                    <TableHead>{t("colWork")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead className="text-right">{t("colDuration")}</TableHead>
                    <TableHead>{t("colNote")}</TableHead>
                    <TableHead className="w-px" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((j) => {
                    const calls = callsOf(j);
                    const shown = open === j.id;
                    return (
                      <Fragment key={j.id}>
                        <TableRow>
                          <TableCell className="whitespace-nowrap text-text-700">
                            {j.startedAt ? formatDateTime(j.startedAt, tz) : "—"}
                          </TableCell>
                          <TableCell>
                            <span className="grid gap-0.5">
                              <span className="text-text-900">{kind(j)}</span>
                              <span className="flex items-center gap-1 text-[13px] text-text-500">
                                {j.direction === "pull" ? (
                                  <ArrowDownToLine className="size-3.5" aria-hidden />
                                ) : (
                                  <ArrowUpFromLine className="size-3.5" aria-hidden />
                                )}
                                {t(`direction_${j.direction}`)}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell>
                            <StatusPill tone={SYNC_TONE[j.status]}>{t(`status_${j.status}`)}</StatusPill>
                          </TableCell>
                          <TableCell className="tabular text-right whitespace-nowrap text-text-700">
                            {durationText(j.durationMs) ?? "—"}
                          </TableCell>
                          <TableCell className="max-w-96 min-w-56 text-[13px] whitespace-normal text-text-700">
                            {j.errorMessage ?? note(j)}
                            {j.attempts > 1 ? (
                              <span className="block text-text-500">{t("attempt", { count: j.attempts })}</span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            {calls.length > 0 ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-expanded={shown}
                                aria-controls={`calls-${j.id}`}
                                onClick={() => setOpen(shown ? null : j.id)}
                              >
                                {t(shown ? "hideCalls" : "showCalls", { count: calls.length })}
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                        {shown ? (
                          <TableRow id={`calls-${j.id}`} className="bg-surface-2 hover:bg-surface-2">
                            <TableCell colSpan={6} className="whitespace-normal">
                              <ol className="grid gap-1 font-mono text-[12px]" aria-label={t("calls")}>
                                {calls.map((c, i) => (
                                  // calls have no id; their order is the order they were made
                                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list read once
                                  <li key={i} className="grid grid-cols-[3.5rem_1fr_auto] gap-2">
                                    <span className="text-text-500">{c.method}</span>
                                    <span className="break-all text-text-900">{c.path}</span>
                                    <span className="text-right whitespace-nowrap text-text-700">
                                      {[c.status ?? c.error ?? "—", c.ms !== null ? `${c.ms} ms` : null]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </span>
                                  </li>
                                ))}
                              </ol>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {log.hasNextPage ? (
              <div className="border-t p-3 text-center">
                <Button variant="secondary" loading={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>
                  {tCommon("loadMore")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
