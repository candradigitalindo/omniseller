"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { ArrowLeft, CheckCircle2, CircleAlert, ScanBarcode, Search } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatNumber, formatRupiah } from "@/lib/format";
import { useCan } from "@/lib/session";
import { Counted, Difference } from "./counts-view";
import {
  COUNT_TONE,
  type CountLine,
  type LineFilter,
  lineFilters,
  ScanBuffer,
  type StockCount,
} from "./stock-ops-meta";

const PAGE = 100;
const APPLY_POLL_MS = 3_000;

/**
 * L22 Stock Opname, one count (DOKUMEN-UI-UX 14.4): scan or type what is on the shelf while counting, then
 * review the differences and apply them. Blind counts hide the system's numbers until submitted.
 */
export function CountDetailView({ id }: { id: string }) {
  const t = useTranslations("counts");
  const count = useQuery({
    queryKey: ["counts", "detail", id],
    queryFn: () => unwrap(api.GET("/v1/stock-counts/{id}", { params: { path: { id } } })),
    // approved: the worker applies it in batches; follow until it is done
    refetchInterval: (q) =>
      q.state.data?.applyRequestedAt && q.state.data.status === "review" ? APPLY_POLL_MS : false,
  });
  if (count.isPending) {
    return (
      <div className="grid gap-3" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (count.isError) return <ErrorState error={count.error} onRetry={() => count.refetch()} />;
  const c = count.data;
  return (
    <>
      <Link
        href="/stok/opname"
        className="mb-2 inline-flex items-center gap-1.5 text-sm text-text-500 hover:text-text-900"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("title")}
      </Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="flex flex-wrap items-center gap-2 text-[22px] leading-tight font-bold text-text-900 md:text-2xl">
            <span className="font-mono">{c.number}</span>
            <StatusPill tone={COUNT_TONE[c.status]}>{t(`status_${c.status}`)}</StatusPill>
          </h1>
          <p className="text-sm text-text-500">
            {c.warehouse?.name ?? "—"} · {t(`mode_${c.mode}`)}
            {c.blind ? ` · ${t("blindShort")}` : ""}
          </p>
        </div>
        <Actions count={c} />
      </div>
      <div className="mb-4 grid gap-3 md:grid-cols-[2fr_1fr]">
        <div className="grid gap-2 rounded-[10px] border bg-surface p-4">
          <Counted count={c} />
          {c.stats.added > 0 ? (
            <p className="text-[13px] text-text-500">{t("addedLines", { count: c.stats.added })}</p>
          ) : null}
        </div>
        <div className="grid content-start gap-1 rounded-[10px] border bg-surface p-4">
          <span className="text-[13px] text-text-500">{t("colDifference")}</span>
          <span className="text-lg font-semibold">
            <Difference count={c} />
          </span>
        </div>
      </div>
      {c.applyRequestedAt && c.status === "review" ? (
        <p
          className="mb-4 rounded-[10px] border border-primary-100 bg-primary-50 p-3 text-sm text-text-900"
          aria-live="polite"
        >
          {t("applying")}
        </p>
      ) : null}
      {c.status === "counting" ? <Scanner count={c} /> : null}
      <Lines count={c} />
    </>
  );
}

function Actions({ count: c }: { count: StockCount }) {
  const t = useTranslations("counts");
  const tCommon = useTranslations("common");
  const can = useCan();
  const queryClient = useQueryClient();
  const [applying, setApplying] = useState(false);
  const [zero, setZero] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["counts"] });
  const step = useMutation({
    mutationFn: (action: "submit" | "reopen" | "cancel") => {
      const path = { params: { path: { id: c.id } } };
      if (action === "submit") return unwrap(api.POST("/v1/stock-counts/{id}/submit", path));
      if (action === "reopen") return unwrap(api.POST("/v1/stock-counts/{id}/reopen", path));
      return unwrap(api.POST("/v1/stock-counts/{id}/cancel", path));
    },
    onSuccess: (_, action) => {
      toast.success(t(`done_${action}`));
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const apply = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/stock-counts/{id}/apply", { params: { path: { id: c.id } }, body: { zeroUncounted: zero } }),
      ),
    onSuccess: () => {
      toast.success(t("applyQueued"));
      setApplying(false);
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const uncounted = c.stats.lines - c.stats.counted;
  return (
    <div className="flex flex-wrap gap-2">
      {c.status === "counting" && can("inventory:count") ? (
        <Button loading={step.isPending && step.variables === "submit"} onClick={() => step.mutate("submit")}>
          {t("submit")}
        </Button>
      ) : null}
      {c.status === "review" && !c.applyRequestedAt && can("inventory:adjust") ? (
        <>
          <Button
            variant="secondary"
            loading={step.isPending && step.variables === "reopen"}
            onClick={() => step.mutate("reopen")}
          >
            {t("reopen")}
          </Button>
          <Button onClick={() => setApplying(true)}>{t("apply")}</Button>
        </>
      ) : null}
      {(c.status === "counting" || (c.status === "review" && !c.applyRequestedAt)) && can("inventory:adjust") ? (
        <Button
          variant="ghost"
          loading={step.isPending && step.variables === "cancel"}
          onClick={() => step.mutate("cancel")}
        >
          {t("cancelCount")}
        </Button>
      ) : null}
      <Dialog open={applying} onOpenChange={setApplying}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t("applyTitle", { number: c.number })}</DialogTitle>
            <DialogDescription>{t("applyBody")}</DialogDescription>
          </DialogHeader>
          {c.difference ? (
            <dl className="grid gap-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-text-500">{t("unitsOver")}</dt>
                <dd className="tabular text-success">+{formatNumber(c.difference.unitsOver)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-text-500">{t("unitsUnder")}</dt>
                <dd className="tabular text-danger">−{formatNumber(c.difference.unitsUnder)}</dd>
              </div>
              {c.difference.value !== null ? (
                <div className="flex justify-between">
                  <dt className="text-text-500">{t("valueDifference")}</dt>
                  <dd className="tabular">{formatRupiah(c.difference.value)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {uncounted > 0 ? (
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <Checkbox
                id="zero-uncounted"
                checked={zero}
                onCheckedChange={(v) => setZero(v === true)}
                className="mt-0.5"
              />
              <Label htmlFor="zero-uncounted" className="grid gap-0.5 font-normal">
                <span className="font-medium text-text-900">{t("zeroUncounted", { count: uncounted })}</span>
                <span className="text-[13px] text-text-500">{t("zeroUncountedHint")}</span>
              </Label>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setApplying(false)}>
              {tCommon("cancel")}
            </Button>
            <Button loading={apply.isPending} onClick={() => apply.mutate()}>
              {t("applyConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type ScanResult = { ok: true; text: string } | { ok: false; text: string };

/** The scan box: a USB scanner types the code and Enter; scans of one code are sent together. */
function Scanner({ count: c }: { count: StockCount }) {
  const t = useTranslations("counts");
  const can = useCan();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [pending, setPending] = useState<{ code: string; qty: number } | null>(null);
  const scan = useMutation({
    mutationFn: (body: { code: string; qty: number }) =>
      unwrap(api.POST("/v1/stock-counts/{id}/scan", { params: { path: { id: c.id } }, body })),
    onSuccess: (r, body) => {
      setResult({
        ok: true,
        text: t("scanned", {
          qty: body.qty,
          sku: r.line.sku,
          name: r.line.productName,
          counted: r.line.countedQty ?? 0,
        }),
      });
      void queryClient.invalidateQueries({ queryKey: ["counts"] });
    },
    onError: (error, body) =>
      setResult({ ok: false, text: t("scanFailed", { code: body.code, reason: errorMessage(error) }) }),
  });
  const send = useRef(scan.mutate);
  useEffect(() => {
    send.current = scan.mutate;
  });
  const buffer = useRef<ScanBuffer | null>(null);
  if (buffer.current === null) {
    buffer.current = new ScanBuffer((code, qty) => {
      setPending(null);
      send.current({ code, qty });
    });
  }
  // what is waiting goes out when the page closes
  useEffect(() => () => buffer.current?.flush(), []);
  if (!can("inventory:count")) return null;

  return (
    <section className="mb-4 grid gap-2 rounded-[10px] border bg-surface p-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const value = code.trim();
          if (!value) return;
          buffer.current?.add(value);
          setPending(buffer.current?.pending ?? null);
          setCode("");
          input.current?.focus();
        }}
      >
        <div className="relative flex-1">
          <ScanBarcode
            className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-text-500"
            aria-hidden
          />
          <Input
            ref={input}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("scanPlaceholder")}
            aria-label={t("scanPlaceholder")}
            className="h-14 pl-11 text-lg md:h-14"
          />
        </div>
        <Button type="submit" size="lg" className="h-14">
          {t("scanAdd")}
        </Button>
      </form>
      {pending ? (
        <p className="text-[13px] text-text-500" aria-live="polite">
          {t("scanPending", { code: pending.code, qty: pending.qty })}
        </p>
      ) : null}
      {result ? (
        <p
          role={result.ok ? "status" : "alert"}
          className={cn(
            "flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm",
            result.ok ? "bg-success-soft text-text-900" : "bg-danger-soft text-danger",
          )}
        >
          {result.ok ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          ) : (
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          {result.text}
        </p>
      ) : null}
    </section>
  );
}

function Lines({ count: c }: { count: StockCount }) {
  const t = useTranslations("counts");
  const tCommon = useTranslations("common");
  const can = useCan();
  const { params, set } = useUrlParams();
  const filters = lineFilters(c);
  const filter: LineFilter =
    filters.find((f) => f === params.get("lines")) ?? (c.status === "review" ? "differences" : "all");
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  useEffect(() => {
    if (search.trim() === q) return;
    const timer = setTimeout(() => set({ q: search.trim() || null }), 300);
    return () => clearTimeout(timer);
  }, [search, q, set]);
  const editable = c.status === "counting" && can("inventory:count");
  const hidden = c.blind && c.status === "counting";
  const lines = useInfiniteQuery({
    queryKey: ["counts", "lines", c.id, filter, q],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/stock-counts/{id}/lines", {
          params: {
            path: { id: c.id },
            query: { filter, ...(q ? { q } : {}), limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = lines.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0"
          role="tablist"
          aria-label={t("lineFilters")}
        >
          {filters.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => set({ lines: f })}
              className={cn(
                "h-9 shrink-0 rounded-full px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === f ? "bg-primary-100 text-primary-600" : "text-text-700 hover:bg-surface-2",
              )}
            >
              {t(`lines_${f}`)}
            </button>
          ))}
        </div>
        <div className="relative min-w-[200px] flex-1 md:max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("lineSearch")}
            aria-label={t("lineSearch")}
            className="pl-9"
          />
        </div>
      </div>
      <div className="overflow-x-auto rounded-[10px] border bg-surface">
        {lines.isPending ? (
          <div className="grid gap-2 p-4" aria-busy>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : lines.isError ? (
          <ErrorState error={lines.error} onRetry={() => lines.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("noLines")} />
        ) : (
          <Table>
            <TableHeader className="bg-surface-2">
              <TableRow>
                <TableHead>{t("bin")}</TableHead>
                <TableHead>{t("sku")}</TableHead>
                <TableHead className="min-w-48">{t("product")}</TableHead>
                {hidden ? null : <TableHead className="text-right">{t("expected")}</TableHead>}
                <TableHead className="min-w-28 text-right">{t("counted")}</TableHead>
                {hidden ? null : <TableHead className="text-right">{t("diff")}</TableHead>}
                {c.status === "applied" ? <TableHead className="text-right">{t("applied")}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((l) => (
                <LineRow
                  key={`${l.id}-${l.countedAt ?? ""}`}
                  countId={c.id}
                  line={l}
                  editable={editable}
                  hidden={hidden}
                  applied={c.status === "applied"}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {lines.hasNextPage ? (
        <Button
          variant="secondary"
          className="justify-self-center"
          loading={lines.isFetchingNextPage}
          onClick={() => lines.fetchNextPage()}
        >
          {tCommon("loadMore")}
        </Button>
      ) : null}
    </section>
  );
}

function LineRow({
  countId,
  line: l,
  editable,
  hidden,
  applied,
}: {
  countId: string;
  line: CountLine;
  editable: boolean;
  hidden: boolean;
  applied: boolean;
}) {
  const t = useTranslations("counts");
  const queryClient = useQueryClient();
  const saved = l.countedQty === null ? "" : String(l.countedQty);
  const [value, setValue] = useState(saved);
  const record = useMutation({
    mutationFn: (qty: number) =>
      unwrap(
        api.PUT("/v1/stock-counts/{id}/lines", {
          params: { path: { id: countId } },
          body: { lines: [{ variantId: l.variantId, qty, mode: "set" }] },
        }),
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["counts"] }),
    onError: (error) => {
      setValue(saved);
      toast.error(errorMessage(error));
    },
  });
  const commit = () => {
    const v = value.trim();
    if (v === saved || v === "") return setValue(saved);
    if (!/^\d+$/.test(v)) {
      toast.error(t("wholeNumber"));
      return setValue(saved);
    }
    record.mutate(Number(v));
  };
  return (
    <TableRow>
      <TableCell className="font-mono text-[13px] text-text-700">{l.binLocation ?? "—"}</TableCell>
      <TableCell className="font-mono text-sm">
        {l.sku}
        {l.added ? (
          <span className="ml-1.5 rounded bg-warning-soft px-1 text-[11px] text-warning">{t("addedBadge")}</span>
        ) : null}
      </TableCell>
      <TableCell className="max-w-72">
        <span className="line-clamp-2 text-sm">
          {l.productName}
          {l.variantName && l.variantName !== l.productName ? (
            <span className="text-text-500"> · {l.variantName}</span>
          ) : null}
        </span>
      </TableCell>
      {hidden ? null : (
        <TableCell className="tabular text-right">
          {l.expectedQty === null ? "—" : formatNumber(l.expectedQty)}
        </TableCell>
      )}
      <TableCell className="text-right">
        {editable ? (
          <Input
            inputMode="numeric"
            aria-label={t("countedFor", { sku: l.sku })}
            className="tabular ml-auto h-10 w-24 text-right md:h-10"
            value={value}
            placeholder="—"
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        ) : (
          <span className="tabular">{l.countedQty === null ? "—" : formatNumber(l.countedQty)}</span>
        )}
      </TableCell>
      {hidden ? null : (
        <TableCell
          className={cn(
            "tabular text-right font-medium",
            (l.diff ?? 0) > 0 && "text-success",
            (l.diff ?? 0) < 0 && "text-danger",
          )}
        >
          {l.diff === null ? "—" : l.diff > 0 ? `+${formatNumber(l.diff)}` : formatNumber(l.diff)}
        </TableCell>
      )}
      {applied ? (
        <TableCell className="tabular text-right">
          {l.appliedDelta === null ? "—" : formatNumber(l.appliedDelta)}
        </TableCell>
      ) : null}
    </TableRow>
  );
}
