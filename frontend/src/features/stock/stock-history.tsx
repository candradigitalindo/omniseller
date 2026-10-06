"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { History, Search } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useCan, useSession, useTimeZone } from "@/lib/session";
import { variantTitle } from "./adjust-dialog";
import {
  actorKind,
  availableSeries,
  changes,
  documentHref,
  MOVEMENT_TONE,
  MOVEMENT_TYPES,
  type Movement,
  movementTypeOf,
  noteFor,
  pointAt,
  signed,
  sparkGeometry,
} from "./history-meta";

const PAGE = 50;
const ALL = "all";

/**
 * L21 Riwayat Stok (DOKUMEN-UI-UX 14.4, backend 8.13 "kartu stok"): every movement of one SKU, newest first:
 * what moved it, the change, the stock after, the document it came from, and who. Above the table, ready to
 * sell over the loaded movements of one warehouse as a small line.
 */
export function StockHistoryView() {
  const t = useTranslations("stockHistory");
  const tCommon = useTranslations("common");
  const can = useCan();
  const me = useSession();
  const tz = useTimeZone();
  const { params, set } = useUrlParams();
  const variantId = params.get("variant");
  const sku = params.get("sku") ?? "";
  const warehouseId = params.get("warehouse");
  const type = movementTypeOf(params.get("type"));
  const allowed = can("inventory:read");

  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 5 * 60_000,
    enabled: allowed,
  });
  // the stock now, from the stock list: the SKU searched, then the variant picked out
  const row = useQuery({
    queryKey: ["stock", "row", variantId, sku],
    queryFn: () =>
      unwrap(api.GET("/v1/inventory", { params: { query: { q: sku, limit: 50, includeArchived: "true" } } })),
    enabled: allowed && variantId !== null && sku !== "",
    select: (page) => page.items.find((r) => r.id === variantId) ?? null,
  });
  // names of the team only for those who manage it; others read "Anggota tim"
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => unwrap(api.GET("/v1/users", { params: { query: { limit: 200 } } })),
    enabled: allowed && can("settings:user"),
    staleTime: 5 * 60_000,
  });
  const query = {
    ...(variantId ? { variantId } : {}),
    ...(warehouseId ? { warehouseId } : {}),
    ...(type ? { type } : {}),
  };
  const movements = useInfiniteQuery({
    queryKey: ["stock", "movements", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/inventory/movements", {
          params: { query: { ...query, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: allowed && variantId !== null,
  });

  if (!allowed) return <PageHeader title={t("title")} description={t("noAccess")} />;

  const allWarehouses = warehouses.data?.items ?? [];
  const names = new Map(allWarehouses.map((w) => [w.id, w.name]));
  const people = new Map((users.data?.items ?? []).map((u) => [u.id, u.name]));
  const rows = movements.data?.pages.flatMap((p) => p.items) ?? [];
  const showWarehouse = warehouseId === null && allWarehouses.length > 1;
  // the line follows one warehouse: the one that moved most in what is loaded (the chosen one when filtered)
  const lineWarehouse = busiestWarehouse(rows);
  const who = (m: Movement) => {
    const kind = actorKind(m.actorUserId, me.user.id);
    if (kind === "other") return people.get(m.actorUserId ?? "") ?? t("actor_other");
    return t(`actor_${kind}`);
  };
  const current = row.data ? { sku: row.data.sku, title: variantTitle(row.data) } : sku ? { sku, title: "" } : null;

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <SkuPicker current={current} onPick={(r) => set({ variant: r.id, sku: r.sku })} />
      {variantId ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {allWarehouses.length > 1 ? (
            <Select value={warehouseId ?? ALL} onValueChange={(v) => set({ warehouse: v === ALL ? null : v })}>
              <SelectTrigger className="h-10 w-52" aria-label={t("warehouse")}>
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
          <Select value={type ?? ALL} onValueChange={(v) => set({ type: v === ALL ? null : v })}>
            <SelectTrigger className="h-10 w-56" aria-label={t("type")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allTypes")}</SelectItem>
              {MOVEMENT_TYPES.map((x) => (
                <SelectItem key={x} value={x}>
                  {t(`type_${x}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {!variantId ? (
        <Card className="mt-4">
          <EmptyState icon={History} title={t("pickSku")} body={t("pickSkuBody")} />
        </Card>
      ) : (
        <div className="mt-4 grid gap-4">
          {row.data ? (
            <Card size="sm">
              <CardContent className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                {row.data.warehouses
                  .filter((w) => !warehouseId || w.warehouseId === warehouseId)
                  .map((w) => (
                    <span key={w.warehouseId} className="grid gap-0.5">
                      <span className="text-[13px] text-text-500">{names.get(w.warehouseId) ?? "—"}</span>
                      <span className="tabular text-text-900">
                        {t("nowStock", { onHand: w.onHand, available: w.available })}
                      </span>
                    </span>
                  ))}
              </CardContent>
            </Card>
          ) : null}
          {lineWarehouse ? (
            <Sparkline
              points={availableSeries(rows, lineWarehouse)}
              title={t("lineTitle", { warehouse: names.get(lineWarehouse) ?? "" })}
              timeZone={tz}
            />
          ) : null}
          <Card className="gap-0 py-0">
            {movements.isPending ? (
              <div className="grid gap-2 p-4" aria-busy>
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : movements.isError ? (
              <ErrorState error={movements.error} onRetry={() => movements.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState icon={History} title={t("empty")} />
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <Table>
                    <TableHeader className="bg-surface-2">
                      <TableRow>
                        <TableHead>{t("colTime")}</TableHead>
                        <TableHead>{t("colType")}</TableHead>
                        {showWarehouse ? <TableHead>{t("colWarehouse")}</TableHead> : null}
                        <TableHead>{t("colChange")}</TableHead>
                        <TableHead className="text-right">{t("colAfter")}</TableHead>
                        <TableHead>{t("colReference")}</TableHead>
                        <TableHead>{t("colBy")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className="whitespace-nowrap text-text-700">
                            {formatDateTime(m.createdAt, tz)}
                          </TableCell>
                          <TableCell>
                            <StatusPill tone={MOVEMENT_TONE[m.type]}>{t(`type_${m.type}`)}</StatusPill>
                          </TableCell>
                          {showWarehouse ? (
                            <TableCell className="text-text-700">{names.get(m.warehouseId) ?? "—"}</TableCell>
                          ) : null}
                          <TableCell>
                            <Changes movement={m} />
                          </TableCell>
                          <TableCell className="text-right">
                            <After movement={m} />
                          </TableCell>
                          <TableCell className="max-w-72">
                            <Reference movement={m} />
                          </TableCell>
                          <TableCell className="text-[13px] text-text-700">{who(m)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <ul className="divide-y md:hidden">
                  {rows.map((m) => (
                    <li key={m.id} className="grid gap-1.5 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <StatusPill tone={MOVEMENT_TONE[m.type]}>{t(`type_${m.type}`)}</StatusPill>
                        <span className="text-[13px] text-text-500">{formatDateTime(m.createdAt, tz)}</span>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <Changes movement={m} />
                        <After movement={m} />
                      </div>
                      <Reference movement={m} />
                      <span className="text-[13px] text-text-500">
                        {showWarehouse ? `${names.get(m.warehouseId) ?? "—"} · ` : null}
                        {who(m)}
                      </span>
                    </li>
                  ))}
                </ul>
                {movements.hasNextPage ? (
                  <div className="border-t p-3 text-center">
                    <Button
                      variant="secondary"
                      loading={movements.isFetchingNextPage}
                      onClick={() => movements.fetchNextPage()}
                    >
                      {tCommon("loadMore")}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function busiestWarehouse(rows: readonly Movement[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.warehouseId, (counts.get(r.warehouseId) ?? 0) + 1);
  let best: string | null = null;
  for (const [id, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = id;
  return best;
}

/** "+ hijau, - merah" (L21), each with what it changed: on hand, reserved, damaged, buffer. */
function Changes({ movement: m }: { movement: Movement }) {
  const t = useTranslations("stockHistory");
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
      {changes(m).map((c) => (
        <span key={c.part} className="whitespace-nowrap">
          <span className="text-text-500">{t(`part_${c.part}`)}</span>{" "}
          <span className={cn("tabular font-semibold", c.delta > 0 ? "text-success" : "text-danger")}>
            {signed(c.delta)}
          </span>
        </span>
      ))}
    </span>
  );
}

function After({ movement: m }: { movement: Movement }) {
  const t = useTranslations("stockHistory");
  return (
    <span className="tabular grid justify-items-end text-sm whitespace-nowrap">
      <span className="font-semibold text-text-900">{t("afterOnHand", { value: m.onHandAfter })}</span>
      <span className={cn("text-[13px]", m.availableAfter < 0 ? "text-danger" : "text-text-500")}>
        {t("afterAvailable", { value: m.availableAfter })}
      </span>
    </span>
  );
}

/** The document it came from (a link when the viewer may open it), then the reason and the note. */
function Reference({ movement: m }: { movement: Movement }) {
  const t = useTranslations("stockHistory");
  const can = useCan();
  const doc = m.document;
  const href = doc ? documentHref(doc, can) : null;
  const note = noteFor(m);
  const detail = [m.reasonLabel, note].filter(Boolean).join(" · ");
  if (!doc && !detail) return <span className="text-text-500">—</span>;
  return (
    <span className="grid gap-0.5">
      {doc && href ? (
        <Link
          href={href}
          aria-label={t(`doc_${doc.type}`, { number: doc.number })}
          className="w-fit font-mono text-sm text-primary-600 underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {doc.number}
        </Link>
      ) : doc ? (
        <span className="font-mono text-sm text-text-900">{doc.number}</span>
      ) : null}
      {detail ? <span className="text-[13px] text-text-700">{detail}</span> : null}
    </span>
  );
}

const SPARK_W = 600;
const SPARK_H = 64;

/**
 * Ready to sell over the loaded movements as a thin step line, one equal step per movement, the zero line drawn
 * when the stock went under it. Hovering reads one movement out under the line; the table holds every number.
 */
function Sparkline({
  points,
  title,
  timeZone,
}: {
  points: { at: string; value: number }[];
  title: string;
  timeZone: string;
}) {
  const t = useTranslations("stockHistory");
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;
  const g = sparkGeometry(points, SPARK_W, SPARK_H);
  const values = points.map((p) => p.value);
  const first = points[0]!;
  const last = points.at(-1)!;
  const shown = hover === null ? null : points[hover];
  return (
    <Card size="sm">
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-text-900">{title}</span>
          <span className="text-[13px] text-text-500">
            {t("lineRange", { from: formatDateTime(first.at, timeZone), to: formatDateTime(last.at, timeZone) })}
          </span>
        </div>
        <svg
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          preserveAspectRatio="none"
          className="h-16 w-full"
          role="img"
          aria-label={t("lineSummary", { from: first.value, to: last.value, count: points.length })}
          onMouseMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            if (box.width > 0) setHover(pointAt(g.band, points.length, ((e.clientX - box.left) / box.width) * SPARK_W));
          }}
          onMouseLeave={() => setHover(null)}
        >
          <line
            x1="0"
            x2={SPARK_W}
            y1={g.zeroY}
            y2={g.zeroY}
            stroke="var(--grid)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={g.d}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth="2"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {hover !== null ? (
            <>
              <line
                x1={(hover + 0.5) * g.band}
                x2={(hover + 0.5) * g.band}
                y1="0"
                y2={SPARK_H}
                stroke="var(--text-500)"
                strokeWidth="1"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              {/* a zero-length line with round caps draws a round dot even when the box is stretched */}
              <line
                x1={(hover + 0.5) * g.band}
                x2={(hover + 0.5) * g.band}
                y1={g.ys[hover]}
                y2={g.ys[hover]}
                stroke="var(--chart-1)"
                strokeWidth="8"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          ) : null}
        </svg>
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-[13px] text-text-500">
          <span className="min-h-5 text-text-700">
            {shown ? t("lineReadout", { at: formatDateTime(shown.at, timeZone), value: shown.value }) : t("lineHint")}
          </span>
          <span className="tabular">
            {t("lineLowHigh", { low: formatNumber(Math.min(...values)), high: formatNumber(Math.max(...values)) })}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/** Finds a SKU in the stock list and opens its card. */
function SkuPicker({
  current,
  onPick,
}: {
  current: { sku: string; title: string } | null;
  onPick: (row: { id: string; sku: string }) => void;
}) {
  const t = useTranslations("stockHistory");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  const found = useQuery({
    queryKey: ["stock", "pick-history", term],
    queryFn: () =>
      unwrap(api.GET("/v1/inventory", { params: { query: { q: term, limit: 8, includeArchived: "true" } } })),
    enabled: term.length >= 2,
  });
  // results only for the text in the box, never for what was typed before
  const results = term.length >= 2 && term === q.trim() ? found.data?.items : undefined;
  return (
    <div className="grid gap-2 md:max-w-xl">
      {current ? (
        <p className="text-sm text-text-900">
          <span className="font-mono font-medium">{current.sku}</span>
          {current.title ? <span className="text-text-500"> · {current.title}</span> : null}
        </p>
      ) : null}
      <Label htmlFor="history-sku">{current ? t("otherSku") : t("findSku")}</Label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
          aria-hidden
        />
        <Input
          id="history-sku"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("skuPlaceholder")}
          className="pl-9"
        />
      </div>
      {results ? (
        <ul className="grid gap-1" aria-label={t("results")}>
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="grid w-full gap-0.5 rounded-lg px-3 py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onPick({ id: r.id, sku: r.sku });
                  setQ("");
                }}
              >
                <span className="font-mono text-sm text-text-900">{r.sku}</span>
                <span className="truncate text-[13px] text-text-500">{variantTitle(r)}</span>
              </button>
            </li>
          ))}
          {results.length === 0 ? <li className="px-3 py-1.5 text-sm text-text-500">{t("noSku")}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
