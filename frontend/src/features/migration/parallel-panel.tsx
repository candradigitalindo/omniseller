"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, CircleDashed, RefreshCw, Rocket, Scale, Undo2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { EmptyState, ErrorState, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import {
  type ChecklistItem,
  COMPARISON_TONE,
  type ComparisonStatus,
  openChecks,
  readyStores,
  type StoreState,
  undoLeft,
} from "./migration-meta";

const COMPARISON_ORDER = [
  "differ",
  "unset",
  "unknown",
  "match",
  "managed",
  "inactive",
] as const satisfies readonly ComparisonStatus[];
const ORDER_STATUSES = [
  "unpaid",
  "new",
  "problem",
  "ready_to_pack",
  "packed",
  "ready_to_ship",
  "shipped",
  "delivered",
  "completed",
  "cancelled",
] as const;
const CHECK_KEYS = [
  "store_connected",
  "orders_imported",
  "warehouses_mapped",
  "listings_mapped",
  "stock_fresh",
  "stock_match",
  "old_app_revoked",
  "parallel_days",
  "stock_unset",
] as const;

function checkKey(key: string): (typeof CHECK_KEYS)[number] | null {
  return CHECK_KEYS.find((k) => k === key) ?? null;
}

/**
 * L46 steps 4 and 5 (backend 8.19): stores still read-only show what OmniSeller would do once live (orders
 * received, stock compared with the marketplace, the checklist), then all ready stores move live at once,
 * which can be undone for 24 hours.
 */
export function ParallelTab() {
  const t = useTranslations("migration");
  const state = useQuery({
    queryKey: ["migration", "parallel"],
    queryFn: () => unwrap(api.GET("/v1/migration/parallel")),
    refetchInterval: 30_000,
  });
  if (state.isPending) {
    return (
      <div className="grid gap-3" aria-busy>
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (state.isError) {
    return (
      <Card>
        <ErrorState error={state.error} onRetry={() => state.refetch()} />
      </Card>
    );
  }
  const stores = state.data.items;
  const readOnly = stores.filter((s) => s.syncMode === "read_only");
  const undoable = stores.filter((s) => s.syncMode === "live" && s.lastCutover?.canUndo);
  return (
    <div className="grid gap-4">
      <Card className="bg-primary-50">
        <CardContent className="grid gap-1 text-sm text-text-900">
          <p className="font-semibold">{t("parallelTitle")}</p>
          <p className="text-text-700">{t("parallelBody")}</p>
        </CardContent>
      </Card>
      {undoable.map((s) => (
        <UndoCard key={s.id} store={s} />
      ))}
      {readOnly.length === 0 ? (
        <Card>
          <EmptyState icon={CheckCircle2} title={t("noParallel")} body={t("noParallelBody")} />
        </Card>
      ) : (
        <>
          {readOnly.map((s) => (
            <StoreCard key={s.id} store={s} />
          ))}
          <CutoverCard stores={readOnly} />
        </>
      )}
    </div>
  );
}

function StoreCard({ store: s }: { store: StoreState }) {
  const t = useTranslations("migration");
  const tOrders = useTranslations("orders");
  const tz = useTimeZone();
  const can = useCan();
  const queryClient = useQueryClient();
  const [comparing, setComparing] = useState(false);
  const [initial, setInitial] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["migration", "parallel"] });
  const pull = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/listings/sync", { body: { storeId: s.id, full: true } })),
    onSuccess: () => {
      toast.success(t("pullStarted"));
      setTimeout(refresh, 5_000);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const orders = s.orders as Record<string, number>;
  const orderTotal = Object.values(orders).reduce((a, b) => a + b, 0);
  const counts = s.stock.counts as Record<string, number>;
  const failing = (key: string) => s.checklist.some((c) => c.key === key && !c.ok);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ChannelIcon channel={s.channel} decorative />
          {s.name}
          <StatusPill tone="warning">{t("parallelPill")}</StatusPill>
          {s.ready ? <StatusPill tone="success">{t("readyPill")}</StatusPill> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-[13px] text-text-500">
          {s.parallelSince
            ? t("parallelSince", { at: formatDateTime(s.parallelSince, tz), days: s.parallelDays ?? 0 })
            : t("parallelSinceUnknown")}
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <section className="grid content-start gap-2" aria-labelledby={`orders-${s.id}`}>
            <h3 id={`orders-${s.id}`} className="text-sm font-semibold text-text-900">
              {t("ordersSince", { count: orderTotal })}
            </h3>
            <p className="text-[13px] text-text-500">{t("ordersSinceHint")}</p>
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-text-700">
              {ORDER_STATUSES.filter((k) => (orders[k] ?? 0) > 0).map((k) => (
                <li key={k}>
                  {tOrders(`status_${k}`)} <span className="tabular font-medium">{formatNumber(orders[k] ?? 0)}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="grid content-start gap-2" aria-labelledby={`stock-${s.id}`}>
            <h3 id={`stock-${s.id}`} className="text-sm font-semibold text-text-900">
              {t("stockCompare")}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {COMPARISON_ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => (
                <StatusPill key={k} tone={COMPARISON_TONE[k]}>
                  {t(`compare_${k}`, { count: counts[k] ?? 0 })}
                </StatusPill>
              ))}
            </div>
            <p className="text-[13px] text-text-500">
              {s.stock.pulledAt ? t("pulledAt", { at: formatRelative(s.stock.pulledAt, tz) }) : t("neverPulled")}
            </p>
            {s.stock.blocked ? <p className="text-[13px] text-danger">{t(`blocked_${s.stock.blocked}`)}</p> : null}
          </section>
        </div>

        <section className="grid gap-2" aria-labelledby={`checks-${s.id}`}>
          <h3 id={`checks-${s.id}`} className="text-sm font-semibold text-text-900">
            {t("checklist")}
          </h3>
          <ul className="grid gap-1.5">
            {s.checklist.map((c) => (
              <CheckRow key={c.key} item={c} />
            ))}
          </ul>
        </section>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setComparing(true)}>
            <Scale aria-hidden />
            {t("seeComparison")}
          </Button>
          {can("catalog:write") ? (
            <Button size="sm" variant="secondary" loading={pull.isPending} onClick={() => pull.mutate()}>
              <RefreshCw aria-hidden />
              {t("pullListings")}
            </Button>
          ) : null}
          {failing("stock_unset") && can("inventory:adjust") ? (
            <Button size="sm" variant="secondary" onClick={() => setInitial(true)}>
              {t("initialStock")}
            </Button>
          ) : null}
          {failing("listings_mapped") ? (
            <Button asChild size="sm" variant="ghost">
              <Link href="/listing">{t("mapListings")}</Link>
            </Button>
          ) : null}
          {failing("warehouses_mapped") || failing("store_connected") ? (
            <Button asChild size="sm" variant="ghost">
              <Link href="/integrasi">{t("openStores")}</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
      <ComparisonSheet store={comparing ? s : null} onClose={() => setComparing(false)} />
      {initial ? <InitialStockDialog store={s} onClose={() => setInitial(false)} onDone={refresh} /> : null}
    </Card>
  );
}

function CheckRow({ item: c }: { item: ChecklistItem }) {
  const t = useTranslations("migration");
  const key = checkKey(c.key);
  const Icon = c.ok ? CheckCircle2 : c.blocking ? CircleAlert : CircleDashed;
  const color = c.ok ? "text-success" : c.blocking ? "text-danger" : "text-warning";
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon className={`mt-0.5 size-4 shrink-0 ${color}`} aria-hidden />
      <span className="grid gap-0.5">
        <span className="text-text-900">
          {key ? t(`check_${key}`) : c.key}
          <span className="sr-only">: {c.ok ? t("checkOk") : c.blocking ? t("checkBlocking") : t("checkAdvice")}</span>
          {!c.blocking && !c.ok ? <span className="text-[13px] text-text-500"> · {t("advice")}</span> : null}
        </span>
        {c.detail && !c.ok ? <span className="text-[13px] text-text-700">{c.detail}</span> : null}
      </span>
    </li>
  );
}

function ComparisonSheet({ store, onClose }: { store: StoreState | null; onClose: () => void }) {
  const t = useTranslations("migration");
  const [status, setStatus] = useState<ComparisonStatus | null>("differ");
  const list = useQuery({
    queryKey: ["migration", "comparison", store?.id, status],
    queryFn: () =>
      unwrap(
        api.GET("/v1/migration/stores/{id}/stock-comparison", {
          params: { path: { id: store?.id ?? "" }, query: { limit: 200, ...(status ? { status } : {}) } },
        }),
      ),
    enabled: store !== null,
  });
  const counts = (list.data?.counts ?? store?.stock.counts ?? {}) as Record<string, number>;
  return (
    <Sheet open={store !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]">
        <SheetHeader className="border-b p-4">
          <SheetTitle>{t("comparisonTitle", { store: store?.name ?? "" })}</SheetTitle>
          <SheetDescription>{t("comparisonBody")}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 p-4">
          <fieldset className="flex flex-wrap gap-1.5" aria-label={t("comparisonFilter")}>
            {COMPARISON_ORDER.map((k) => (
              <Button
                key={k}
                size="sm"
                variant={status === k ? "default" : "ghost"}
                aria-pressed={status === k}
                onClick={() => setStatus(status === k ? null : k)}
              >
                {t(`compare_${k}`, { count: counts[k] ?? 0 })}
              </Button>
            ))}
          </fieldset>
          {list.isPending ? (
            <Skeleton className="h-40" />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : list.data.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-500">{t("comparisonEmpty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-surface-2">
                  <TableRow>
                    <TableHead>{t("colListing")}</TableHead>
                    <TableHead className="text-right">{t("colMarketplace")}</TableHead>
                    <TableHead className="text-right">{t("colOmniseller")}</TableHead>
                    <TableHead className="text-right">{t("colDifference")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.items.map((i) => (
                    <TableRow key={i.listingId}>
                      <TableCell className="max-w-56">
                        <div className="grid gap-0.5">
                          <span className="font-mono text-sm text-text-900">{i.sku}</span>
                          <span className="truncate text-[13px] text-text-500" title={i.title}>
                            {i.title}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {i.marketplace === null ? "—" : formatNumber(i.marketplace)}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {i.omniseller === null ? "—" : formatNumber(i.omniseller)}
                      </TableCell>
                      <TableCell className="tabular text-right font-semibold">
                        {i.difference === null ? "—" : `${i.difference > 0 ? "+" : ""}${formatNumber(i.difference)}`}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={COMPARISON_TONE[i.status]}>{t(`compareOne_${i.status}`)}</StatusPill>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {list.data?.more ? <p className="text-[13px] text-text-500">{t("comparisonMore")}</p> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Stock never set in OmniSeller taken from the store's marketplace stock, after a look at what it would do. */
function InitialStockDialog({
  store,
  onClose,
  onDone,
}: {
  store: StoreState;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("migration");
  const tCommon = useTranslations("common");
  const preview = useQuery({
    queryKey: ["migration", "initial-stock", store.id],
    queryFn: () => unwrap(api.POST("/v1/inventory/initial-stock", { body: { storeId: store.id, dryRun: true } })),
  });
  const apply = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/inventory/initial-stock", { body: { storeId: store.id, dryRun: false } })),
    onSuccess: (r) => {
      toast.success(t("initialStockDone", { count: r.lines.filter((l) => l.status === "set").length }));
      onDone();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const lines = preview.data?.lines ?? [];
  const toSet = lines.filter((l) => l.status === "set");
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("initialStockTitle", { store: store.name })}</DialogTitle>
          <DialogDescription>{t("initialStockBody")}</DialogDescription>
        </DialogHeader>
        {preview.isPending ? (
          <Skeleton className="h-24" />
        ) : preview.isError ? (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(preview.error)}
          </p>
        ) : (
          <div className="grid gap-2 text-sm">
            <p className="text-text-900">
              {t("initialStockPreview", { set: toSet.length, other: lines.length - toSet.length })}
            </p>
            <ul className="grid max-h-56 gap-1 overflow-y-auto">
              {toSet.slice(0, 50).map((l) => (
                <li key={`${l.variantId}|${l.warehouseId}`} className="flex justify-between gap-3">
                  <span className="truncate font-mono text-[13px] text-text-700">{l.sku}</span>
                  <span className="tabular shrink-0">{formatNumber(l.marketplaceQty)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button disabled={toSet.length === 0} loading={apply.isPending} onClick={() => apply.mutate()}>
            {t("initialStockApply", { count: toSet.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Pindah sepenuhnya ke OmniSeller" (L46 step 5): the ready stores move live together after the seller
 * confirms the old app's access is revoked; one store failing its checklist stops them all (409).
 */
function CutoverCard({ stores }: { stores: StoreState[] }) {
  const t = useTranslations("migration");
  const can = useCan();
  const queryClient = useQueryClient();
  const ready = readyStores(stores);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(ready.map((s) => s.id)));
  const [revoked, setRevoked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cutover = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/v1/migration/cutover", { body: { storeIds: [...chosen], oldAppRevoked: true } })),
    onSuccess: (r) => {
      toast.success(t("cutoverDone", { count: r.items.length }));
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: ["migration", "parallel"] });
      void queryClient.invalidateQueries({ queryKey: ["stores"] });
    },
    onError: (e) => {
      setProblem(
        e instanceof ApiError && e.code === "cutover.checklist_failed" ? t("cutoverRefused") : errorMessage(e),
      );
      void queryClient.invalidateQueries({ queryKey: ["migration", "parallel"] });
    },
  });
  if (!can("settings:store")) return null;
  const selected = [...chosen].filter((id) => ready.some((s) => s.id === id));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cutoverTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-text-700">{t("cutoverBody")}</p>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium text-text-700">{t("cutoverStores")}</legend>
          {stores.map((s) => {
            const open = openChecks(s);
            const isReady = ready.includes(s);
            return (
              <Label
                key={s.id}
                htmlFor={`cutover-${s.id}`}
                className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 font-normal has-[[data-disabled]]:cursor-not-allowed has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-50"
              >
                <Checkbox
                  id={`cutover-${s.id}`}
                  className="mt-0.5"
                  disabled={!isReady}
                  checked={isReady && chosen.has(s.id)}
                  onCheckedChange={(on) =>
                    setChosen((x) => {
                      const next = new Set(x);
                      if (on) next.add(s.id);
                      else next.delete(s.id);
                      return next;
                    })
                  }
                />
                <span className="grid gap-0.5">
                  <span className="flex items-center gap-1.5 text-sm text-text-900">
                    <ChannelIcon channel={s.channel} decorative />
                    {s.name}
                  </span>
                  <span className="text-[13px] text-text-500">
                    {isReady ? t("storeReady") : t("storeNotReady", { count: open.length })}
                  </span>
                </span>
              </Label>
            );
          })}
        </fieldset>
        <Label htmlFor="old-app-revoked" className="flex cursor-pointer items-start gap-3 font-normal">
          <Checkbox
            id="old-app-revoked"
            className="mt-0.5"
            checked={revoked}
            onCheckedChange={(v) => setRevoked(v === true)}
          />
          <span className="text-sm text-text-900">{t("revokedConfirm")}</span>
        </Label>
        {problem ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {problem}
          </p>
        ) : null}
        <div className="grid justify-items-start gap-1.5">
          <Button
            size="lg"
            disabled={selected.length === 0 || !revoked}
            loading={cutover.isPending}
            onClick={() => cutover.mutate()}
          >
            <Rocket aria-hidden />
            {t("cutoverButton")}
          </Button>
          <span className="text-[13px] text-text-500">
            {selected.length === 0 ? t("cutoverNoneReady") : t("cutoverUndoHint")}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function UndoCard({ store: s }: { store: StoreState }) {
  const t = useTranslations("migration");
  const tz = useTimeZone();
  const can = useCan();
  const queryClient = useQueryClient();
  const c = s.lastCutover;
  const undo = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/migration/cutovers/{id}/undo", { params: { path: { id: c?.id ?? "" } } })),
    onSuccess: () => {
      toast.success(t("undone", { store: s.name }));
      void queryClient.invalidateQueries({ queryKey: ["migration", "parallel"] });
      void queryClient.invalidateQueries({ queryKey: ["stores"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!c || undoLeft(c) === 0) return null;
  return (
    <Card size="sm">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <span className="grid gap-0.5 text-sm">
          <span className="flex items-center gap-1.5 font-medium text-text-900">
            <ChannelIcon channel={s.channel} decorative />
            {t("liveSince", { store: s.name, at: formatRelative(c.createdAt, tz) })}
          </span>
          <span className="text-[13px] text-text-500">{t("undoUntil", { at: formatDateTime(c.undoUntil, tz) })}</span>
        </span>
        {can("settings:store") ? (
          <Button size="sm" variant="secondary" loading={undo.isPending} onClick={() => undo.mutate()}>
            <Undo2 aria-hidden />
            {t("undo")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
