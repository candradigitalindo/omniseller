"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, ArrowRight, Plus, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { FilterChip } from "@/components/common/filter-chip";
import { EmptyState, ErrorState, PageHeader, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/errors";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useCan, useSession, useTimeZone } from "@/lib/session";
import { receiptLines, TRANSFER_TONE, type Transfer, type TransferStatus, transferSides } from "./stock-ops-meta";

const PAGE = 50;
const STATUSES: TransferStatus[] = ["draft", "sent", "received", "cancelled"];

/** L23 Transfer Stok (DOKUMEN-UI-UX 14.4): goods moving between warehouses, from draft to received. */
export function TransfersView() {
  const t = useTranslations("transfers");
  const tCommon = useTranslations("common");
  const can = useCan();
  const tz = useTimeZone();
  const { params, set } = useUrlParams();
  const status = STATUSES.find((s) => s === params.get("status")) ?? null;
  const openId = params.get("id");
  const [creating, setCreating] = useState(false);
  const query = status ? { status } : {};
  const list = useInfiniteQuery({
    queryKey: ["transfers", "list", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/stock-transfers", {
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
          can("inventory:transfer") ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t("create")}
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
            icon={ArrowLeftRight}
            title={status ? t("emptyFiltered") : t("empty")}
            body={status ? undefined : t("emptyBody")}
          />
        ) : (
          <>
            <Table className="hidden md:table">
              <TableHeader className="bg-surface-2">
                <TableRow>
                  <TableHead>{t("colNumber")}</TableHead>
                  <TableHead>{t("colRoute")}</TableHead>
                  <TableHead className="text-right">{t("colUnits")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colUpdated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((x) => (
                  <TableRow key={x.id} className="h-[52px] cursor-pointer" onClick={() => set({ id: x.id })}>
                    <TableCell className="font-mono text-sm font-medium">{x.number}</TableCell>
                    <TableCell>
                      <Route transfer={x} />
                    </TableCell>
                    <TableCell className="tabular text-right">{formatNumber(x.units)}</TableCell>
                    <TableCell>
                      <StatusPill tone={TRANSFER_TONE[x.status]}>{t(`status_${x.status}`)}</StatusPill>
                    </TableCell>
                    <TableCell className="text-[13px] text-text-700">{formatDateTime(x.statusChangedAt, tz)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ul className="divide-y md:hidden">
              {rows.map((x) => (
                <li key={x.id}>
                  <button type="button" className="grid w-full gap-1 p-4 text-left" onClick={() => set({ id: x.id })}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-medium text-text-900">{x.number}</span>
                      <StatusPill tone={TRANSFER_TONE[x.status]}>{t(`status_${x.status}`)}</StatusPill>
                    </span>
                    <Route transfer={x} />
                    <span className="text-[13px] text-text-500">{t("unitsCount", { count: x.units })}</span>
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
      <CreateTransferDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => set({ id })} />
      <TransferSheet id={openId} onClose={() => set({ id: null })} />
    </>
  );
}

function Route({ transfer: x }: { transfer: Pick<Transfer, "from" | "to"> }) {
  return (
    <span className="flex items-center gap-1.5 text-sm text-text-900">
      {x.from?.name ?? "—"}
      <ArrowRight className="size-3.5 text-text-500" aria-hidden />
      {x.to?.name ?? "—"}
    </span>
  );
}

type Line = { variantId: string; sku: string; name: string; available: number | null; qty: string };

function CreateTransferDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("transfers");
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createBody")}</DialogDescription>
        </DialogHeader>
        {open ? <CreateTransferForm onClose={onClose} onCreated={onCreated} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateTransferForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations("transfers");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  // one key per form: a double click or a retry after a lost answer creates one transfer
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 300_000,
  });
  const destinations = useQuery({
    queryKey: ["transfers", "destinations"],
    queryFn: () => unwrap(api.GET("/v1/stock-transfers/destinations")),
    staleTime: 300_000,
  });
  const origins = warehouses.data?.items.filter((w) => w.active) ?? [];
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/stock-transfers", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body: {
            fromWarehouseId: from,
            toWarehouseId: to,
            note: note.trim() || null,
            lines: lines.map((l) => ({ variantId: l.variantId, qty: Number(l.qty) })),
          },
        }),
      ),
    onSuccess: (x) => {
      toast.success(t("created", { number: x.number }));
      void queryClient.invalidateQueries({ queryKey: ["transfers"] });
      onClose();
      onCreated(x.id);
    },
    onError: (error) =>
      setProblem(error instanceof ApiError ? (error.errors[0]?.message ?? errorMessage(error)) : errorMessage(error)),
  });
  const submit = () => {
    if (!from || !to) return setProblem(t("chooseBoth"));
    if (from === to) return setProblem(t("sameWarehouse"));
    if (lines.length === 0) return setProblem(t("noLines"));
    const bad = lines.find((l) => !/^\d+$/.test(l.qty.trim()) || Number(l.qty) < 1);
    if (bad) return setProblem(t("qtyRequired", { sku: bad.sku }));
    const over = lines.find((l) => l.available !== null && Number(l.qty) > l.available);
    if (over) return setProblem(t("overAvailable", { sku: over.sku, available: over.available ?? 0 }));
    setProblem(null);
    create.mutate();
  };
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="transfer-from">{t("from")}</Label>
          <Select
            value={from}
            onValueChange={(v) => {
              setFrom(v);
              setLines([]);
            }}
          >
            <SelectTrigger id="transfer-from" className="w-full">
              <SelectValue placeholder={t("chooseWarehouse")} />
            </SelectTrigger>
            <SelectContent>
              {origins.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ArrowRight className="mx-auto hidden size-4 text-text-500 sm:mb-3 sm:block" aria-hidden />
        <div className="grid gap-1.5">
          <Label htmlFor="transfer-to">{t("to")}</Label>
          <Select value={to} onValueChange={setTo}>
            <SelectTrigger id="transfer-to" className="w-full">
              <SelectValue placeholder={t("chooseWarehouse")} />
            </SelectTrigger>
            <SelectContent>
              {(destinations.data?.items ?? [])
                .filter((w) => w.id !== from)
                .map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {from ? (
        <LinePicker
          warehouseId={from}
          lines={lines}
          onAdd={(l) => setLines((prev) => (prev.some((x) => x.variantId === l.variantId) ? prev : [...prev, l]))}
        />
      ) : null}
      {lines.length > 0 ? (
        <ul className="grid gap-2">
          {lines.map((l) => (
            <li key={l.variantId} className="flex items-center gap-3 rounded-lg border p-3">
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="font-mono text-sm text-text-900">{l.sku}</span>
                <span className="truncate text-[13px] text-text-500">
                  {l.name}
                  {l.available !== null ? ` · ${t("available", { count: l.available })}` : ""}
                </span>
              </span>
              <Input
                inputMode="numeric"
                aria-label={t("qtyFor", { sku: l.sku })}
                className="tabular h-10 w-24 text-right md:h-10"
                value={l.qty}
                onChange={(e) =>
                  setLines((prev) => prev.map((x) => (x.variantId === l.variantId ? { ...x, qty: e.target.value } : x)))
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("removeLine", { sku: l.sku })}
                onClick={() => setLines((prev) => prev.filter((x) => x.variantId !== l.variantId))}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="transfer-note">{t("note")}</Label>
        <Textarea id="transfer-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
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
          {t("createSubmit")}
        </Button>
      </DialogFooter>
    </div>
  );
}

/** SKUs at the origin, found by SKU or name, with what is available there. */
function LinePicker({
  warehouseId,
  lines,
  onAdd,
}: {
  warehouseId: string;
  lines: Line[];
  onAdd: (line: Line) => void;
}) {
  const t = useTranslations("transfers");
  const [q, setQ] = useState("");
  const term = q.trim();
  const found = useQuery({
    queryKey: ["stock", "pick", warehouseId, term],
    queryFn: () => unwrap(api.GET("/v1/inventory", { params: { query: { q: term, warehouseId, limit: 8 } } })),
    enabled: term.length >= 2,
  });
  return (
    <div className="grid gap-2">
      <Label htmlFor="transfer-search">{t("addSku")}</Label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-500"
          aria-hidden
        />
        <Input
          id="transfer-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("skuSearch")}
          className="pl-9"
        />
      </div>
      {term.length >= 2 && found.data ? (
        <ul className="grid max-h-48 gap-1 overflow-y-auto">
          {found.data.items
            .filter((r) => !lines.some((l) => l.variantId === r.id))
            .map((r) => {
              const available = r.warehouses.find((w) => w.warehouseId === warehouseId)?.available ?? 0;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      onAdd({
                        variantId: r.id,
                        sku: r.sku,
                        name: r.productName,
                        available,
                        qty: available > 0 ? "1" : "",
                      });
                      setQ("");
                    }}
                  >
                    <span className="grid min-w-0 gap-0.5">
                      <span className="font-mono text-sm text-text-900">{r.sku}</span>
                      <span className="truncate text-[13px] text-text-500">{r.productName}</span>
                    </span>
                    <span className="tabular shrink-0 text-[13px] text-text-700">
                      {t("available", { count: available })}
                    </span>
                  </button>
                </li>
              );
            })}
        </ul>
      ) : null}
    </div>
  );
}

/** One transfer in a side panel: its lines, and the step the user's side may take now. */
function TransferSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTranslations("transfers");
  return (
    <Sheet open={id !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[480px]">
        {id ? <TransferBody key={id} id={id} /> : <SheetTitle className="sr-only">{t("detailTitle")}</SheetTitle>}
      </SheetContent>
    </Sheet>
  );
}

function TransferBody({ id }: { id: string }) {
  const t = useTranslations("transfers");
  const tz = useTimeZone();
  const can = useCan();
  const me = useSession();
  const queryClient = useQueryClient();
  const [received, setReceived] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const detail = useQuery({
    queryKey: ["transfers", "detail", id],
    queryFn: () => unwrap(api.GET("/v1/stock-transfers/{id}", { params: { path: { id } } })),
  });
  const step = useMutation({
    mutationFn: (action: "send" | "cancel" | "receive") => {
      const path = { params: { path: { id } } };
      if (action === "send") return unwrap(api.POST("/v1/stock-transfers/{id}/send", path));
      if (action === "cancel") return unwrap(api.POST("/v1/stock-transfers/{id}/cancel", path));
      return unwrap(
        api.POST("/v1/stock-transfers/{id}/receive", {
          ...path,
          body: { lines: receiptLines(detail.data?.lines ?? [], received), note: note.trim() || null },
        }),
      );
    },
    onSuccess: (_, action) => {
      toast.success(t(`done_${action}`));
      void queryClient.invalidateQueries({ queryKey: ["transfers"] });
      void queryClient.invalidateQueries({ queryKey: ["stock"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  if (detail.isPending) {
    return (
      <div className="grid gap-3 p-4" aria-busy>
        <SheetTitle className="sr-only">{t("detailTitle")}</SheetTitle>
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <>
        <SheetHeader className="border-b">
          <SheetTitle>{t("detailTitle")}</SheetTitle>
        </SheetHeader>
        <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
      </>
    );
  }
  const x = detail.data;
  const sides = transferSides(x, me.warehouseScope);
  const act = can("inventory:transfer");
  return (
    <>
      <SheetHeader className="gap-1.5 border-b pr-12">
        <SheetTitle className="flex items-center gap-2">
          <span className="font-mono">{x.number}</span>
          <StatusPill tone={TRANSFER_TONE[x.status]}>{t(`status_${x.status}`)}</StatusPill>
        </SheetTitle>
        <SheetDescription asChild>
          <div>
            <Route transfer={x} />
          </div>
        </SheetDescription>
      </SheetHeader>
      <div className="grid flex-1 content-start gap-3 overflow-y-auto bg-canvas p-4">
        <section className="grid gap-2 rounded-[10px] border bg-surface p-4">
          <h3 className="text-[15px] font-semibold text-text-900">{t("linesTitle", { count: x.lines.length })}</h3>
          <ul className="grid gap-2">
            {x.lines.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="grid min-w-0 gap-0.5">
                  <span className="font-mono text-text-900">{l.sku ?? "—"}</span>
                  <span className="truncate text-[13px] text-text-500">
                    {l.productName ?? ""}
                    {l.variantName && l.variantName !== l.productName ? ` · ${l.variantName}` : ""}
                  </span>
                  {l.missingQty ? (
                    <span className="text-[13px] text-danger">{t("missing", { count: l.missingQty })}</span>
                  ) : null}
                </span>
                {x.status === "sent" && act && sides.destination ? (
                  <Input
                    inputMode="numeric"
                    aria-label={t("receivedFor", { sku: l.sku ?? "" })}
                    className="tabular h-10 w-24 text-right md:h-10"
                    value={String(received[l.id] ?? l.qty)}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setReceived((prev) => ({
                        ...prev,
                        [l.id]: Number.isInteger(n) && n >= 0 ? Math.min(n, l.qty) : 0,
                      }));
                    }}
                  />
                ) : (
                  <span className="tabular shrink-0 text-text-900">
                    ×{formatNumber(l.qty)}
                    {l.receivedQty !== null && l.receivedQty !== l.qty
                      ? ` (${t("receivedShort", { count: l.receivedQty })})`
                      : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="grid gap-1 rounded-[10px] border bg-surface p-4 text-sm text-text-700">
          {x.note ? <p className="whitespace-pre-wrap text-text-900">{x.note}</p> : null}
          {x.sentAt ? <p>{t("sentAt", { at: formatDateTime(x.sentAt, tz) })}</p> : null}
          {x.receivedAt ? <p>{t("receivedAt", { at: formatDateTime(x.receivedAt, tz) })}</p> : null}
          {x.receiptNote ? <p className="whitespace-pre-wrap">{x.receiptNote}</p> : null}
          {x.cancelledAt ? <p>{t("cancelledAt", { at: formatDateTime(x.cancelledAt, tz) })}</p> : null}
        </section>
        {x.status === "sent" && act && sides.destination ? (
          <div className="grid gap-1.5">
            <Label htmlFor="receive-note">{t("receiptNote")}</Label>
            <Textarea
              id="receive-note"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        ) : null}
      </div>
      {act ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-surface p-4">
          {(x.status === "draft" || x.status === "sent") && sides.origin ? (
            <Button
              variant="ghost"
              loading={step.isPending && step.variables === "cancel"}
              onClick={() => step.mutate("cancel")}
            >
              {t("cancel")}
            </Button>
          ) : null}
          {x.status === "draft" && sides.origin ? (
            <Button loading={step.isPending && step.variables === "send"} onClick={() => step.mutate("send")}>
              {t("send")}
            </Button>
          ) : null}
          {x.status === "sent" && sides.destination ? (
            <Button loading={step.isPending && step.variables === "receive"} onClick={() => step.mutate("receive")}>
              {t("receive")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
