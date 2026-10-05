"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { FilterChip } from "@/components/common/filter-chip";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatDateTime, formatNumber, formatRupiah } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import { COUNT_TONE, type CountStatus, countedPercent, type StockCount } from "./stock-ops-meta";

const PAGE = 50;
const STATUSES: CountStatus[] = ["counting", "review", "applied", "cancelled"];

/**
 * L22 Stock Opname, the list (DOKUMEN-UI-UX 14.4): each count with its warehouse, kind, how far counting
 * got, and the difference once it is no longer blind.
 */
export function CountsView() {
  const t = useTranslations("counts");
  const tCommon = useTranslations("common");
  const can = useCan();
  const tz = useTimeZone();
  const { params, set } = useUrlParams();
  const status = STATUSES.find((s) => s === params.get("status")) ?? null;
  const [creating, setCreating] = useState(false);
  const query = status ? { status } : {};
  const list = useInfiniteQuery({
    queryKey: ["counts", "list", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/stock-counts", {
          params: { query: { ...query, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          can("inventory:count") ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t("start")}
            </Button>
          ) : null
        }
      />
      <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        {STATUSES.map((s) => (
          <FilterChip key={s} active={status === s} onClick={() => set({ status: status === s ? null : s })}>
            {t(`status_${s}`)}
          </FilterChip>
        ))}
      </div>
      <Card className="gap-0 py-0">
        {list.isPending ? (
          <div className="grid gap-2 p-4" aria-busy>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title={status ? t("emptyFiltered") : t("empty")}
            body={status ? undefined : t("emptyBody")}
          />
        ) : (
          <>
            <Table className="hidden md:table">
              <TableHeader className="bg-surface-2">
                <TableRow>
                  <TableHead>{t("colNumber")}</TableHead>
                  <TableHead>{t("colWarehouse")}</TableHead>
                  <TableHead>{t("colKind")}</TableHead>
                  <TableHead className="min-w-40">{t("colProgress")}</TableHead>
                  <TableHead className="text-right">{t("colDifference")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colCreated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id} className="h-[52px]">
                    <TableCell>
                      <Link
                        href={`/stok/opname/${c.id}`}
                        className="font-mono text-sm font-medium text-primary hover:underline"
                      >
                        {c.number}
                      </Link>
                    </TableCell>
                    <TableCell>{c.warehouse?.name ?? "—"}</TableCell>
                    <TableCell>
                      {t(`mode_${c.mode}`)}
                      {c.blind ? <span className="ml-1.5 text-[13px] text-text-500">{t("blindShort")}</span> : null}
                    </TableCell>
                    <TableCell>
                      <Counted count={c} />
                    </TableCell>
                    <TableCell className="tabular text-right">
                      <Difference count={c} />
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={COUNT_TONE[c.status]}>{t(`status_${c.status}`)}</StatusPill>
                    </TableCell>
                    <TableCell className="text-[13px] text-text-700">{formatDateTime(c.createdAt, tz)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ul className="divide-y md:hidden">
              {rows.map((c) => (
                <li key={c.id}>
                  <Link href={`/stok/opname/${c.id}`} className="grid gap-1.5 p-4">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-medium text-text-900">{c.number}</span>
                      <StatusPill tone={COUNT_TONE[c.status]}>{t(`status_${c.status}`)}</StatusPill>
                    </span>
                    <span className="text-sm text-text-700">
                      {c.warehouse?.name ?? "—"} · {t(`mode_${c.mode}`)}
                    </span>
                    <Counted count={c} />
                  </Link>
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
      <CreateCountDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function Counted({ count: c }: { count: StockCount }) {
  const t = useTranslations("counts");
  const pct = countedPercent(c.stats);
  return (
    <span className="grid gap-1">
      <span className="text-[13px] text-text-700">
        {t("countedOf", { counted: formatNumber(c.stats.counted), lines: formatNumber(c.stats.lines) })}
      </span>
      <Progress value={pct} aria-label={t("colProgress")} />
    </span>
  );
}

export function Difference({ count: c }: { count: StockCount }) {
  const t = useTranslations("counts");
  if (!c.difference) return <span className="text-text-500">{t("hiddenWhileBlind")}</span>;
  const { unitsOver, unitsUnder, value } = c.difference;
  return (
    <span className="grid justify-items-end gap-0.5">
      <span>
        <span className="text-success">+{formatNumber(unitsOver)}</span>{" "}
        <span className="text-danger">−{formatNumber(unitsUnder)}</span>
      </span>
      {value !== null ? <span className="text-[13px] text-text-500">{formatRupiah(value)}</span> : null}
    </span>
  );
}

type Picked = { id: string; sku: string; name: string };

function CreateCountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("counts");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>{t("startTitle")}</DialogTitle>
          <DialogDescription>{t("startBody")}</DialogDescription>
        </DialogHeader>
        {open ? <CreateCountForm onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateCountForm({ onClose }: { onClose: () => void }) {
  const t = useTranslations("counts");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const queryClient = useQueryClient();
  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 300_000,
  });
  const usable = warehouses.data?.items.filter((w) => w.active) ?? [];
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [binPrefix, setBinPrefix] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [blind, setBlind] = useState(true);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = warehouseId || usable.find((w) => w.isDefault)?.id || usable[0]?.id || "";

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/stock-counts", {
          body: {
            warehouseId: chosen,
            mode,
            ...(mode === "partial" && binPrefix.trim() ? { binPrefix: binPrefix.trim() } : {}),
            ...(mode === "partial" && picked.length > 0 ? { variantIds: picked.map((p) => p.id) } : {}),
            blind,
            note: note.trim() || null,
          },
        }),
      ),
    onSuccess: (count) => {
      toast.success(t("started", { number: count.number }));
      void queryClient.invalidateQueries({ queryKey: ["counts"] });
      onClose();
      router.push(`/stok/opname/${count.id}`);
    },
    onError: (error) =>
      setProblem(error instanceof ApiError ? (error.errors[0]?.message ?? errorMessage(error)) : errorMessage(error)),
  });
  const submit = () => {
    if (!chosen) return setProblem(t("chooseWarehouse"));
    if (mode === "partial" && !binPrefix.trim() && picked.length === 0) return setProblem(t("partialNeedsScope"));
    setProblem(null);
    create.mutate();
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="count-warehouse">{t("warehouse")}</Label>
        <Select value={chosen} onValueChange={setWarehouseId}>
          <SelectTrigger id="count-warehouse" className="w-full">
            <SelectValue placeholder={t("chooseWarehouse")} />
          </SelectTrigger>
          <SelectContent>
            {usable.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <RadioGroup
        value={mode}
        onValueChange={(v) => setMode(v === "partial" ? "partial" : "full")}
        className="grid gap-2 sm:grid-cols-2"
      >
        {(["full", "partial"] as const).map((m) => (
          <div key={m} className="flex items-start gap-3 rounded-lg border p-3">
            <RadioGroupItem value={m} id={`count-mode-${m}`} className="mt-0.5" />
            <Label htmlFor={`count-mode-${m}`} className="grid gap-0.5 font-normal">
              <span className="font-medium text-text-900">{t(`mode_${m}`)}</span>
              <span className="text-[13px] text-text-500">{t(`modeHint_${m}`)}</span>
            </Label>
          </div>
        ))}
      </RadioGroup>
      {mode === "partial" ? (
        <div className="grid gap-3 rounded-lg border p-3">
          <div className="grid gap-1.5">
            <Label htmlFor="count-bin">{t("binPrefix")}</Label>
            <Input
              id="count-bin"
              value={binPrefix}
              maxLength={50}
              className="font-mono"
              placeholder="A-01"
              onChange={(e) => setBinPrefix(e.target.value)}
            />
          </div>
          <VariantChooser warehouseId={chosen} picked={picked} onChange={setPicked} />
        </div>
      ) : null}
      <div className="flex items-start gap-3">
        <Checkbox id="count-blind" checked={blind} onCheckedChange={(v) => setBlind(v === true)} className="mt-0.5" />
        <Label htmlFor="count-blind" className="grid gap-0.5 font-normal">
          <span className="font-medium text-text-900">{t("blind")}</span>
          <span className="text-[13px] text-text-500">{t("blindHint")}</span>
        </Label>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="count-note">{t("note")}</Label>
        <Textarea id="count-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {problem ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {problem}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button loading={create.isPending} onClick={submit}>
          {t("startSubmit")}
        </Button>
      </DialogFooter>
    </div>
  );
}

/** SKUs for a partial count, found by SKU or name in the stock list of the warehouse. */
function VariantChooser({
  warehouseId,
  picked,
  onChange,
}: {
  warehouseId: string;
  picked: Picked[];
  onChange: (next: Picked[]) => void;
}) {
  const t = useTranslations("counts");
  const [q, setQ] = useState("");
  const term = q.trim();
  const found = useQuery({
    queryKey: ["stock", "pick", warehouseId, term],
    queryFn: () =>
      unwrap(
        api.GET("/v1/inventory", { params: { query: { q: term, limit: 8, ...(warehouseId ? { warehouseId } : {}) } } }),
      ),
    enabled: term.length >= 2,
  });
  return (
    <div className="grid gap-2">
      <Label htmlFor="count-sku-search">{t("skus")}</Label>
      {picked.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {picked.map((p) => (
            <li
              key={p.id}
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-1 pl-2.5 text-[13px]"
            >
              <span className="font-mono">{p.sku}</span>
              <button
                type="button"
                className="grid size-5 place-items-center rounded-full hover:bg-border"
                aria-label={t("removeSku", { sku: p.sku })}
                onClick={() => onChange(picked.filter((x) => x.id !== p.id))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
          aria-hidden
        />
        <Input
          id="count-sku-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("skuSearch")}
          className="pl-9"
        />
      </div>
      {term.length >= 2 && found.data ? (
        <ul className="grid max-h-48 gap-1 overflow-y-auto">
          {found.data.items
            .filter((r) => !picked.some((p) => p.id === r.id))
            .map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="grid w-full gap-0.5 rounded-lg px-3 py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    onChange([...picked, { id: r.id, sku: r.sku, name: r.productName }]);
                    setQ("");
                  }}
                >
                  <span className="font-mono text-sm text-text-900">{r.sku}</span>
                  <span className="truncate text-[13px] text-text-500">{r.productName}</span>
                </button>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
