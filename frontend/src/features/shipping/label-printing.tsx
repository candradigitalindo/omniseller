"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, FileText, Printer, RotateCcw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ChannelIcon } from "@/components/common/channel";
import { EmptyState, ErrorState, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { STATUS_PILL } from "@/features/orders/order-meta";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import { DocumentResult, PrintSettingsPanel, useDocument, usePrintSettings } from "./print-target";
import { JOB_TONE } from "./shipping-meta";

const PAGE = 100;
/**
 * Orders worth printing for: ready to pack (pick lists), packed (manual orders' own labels), and ready to
 * ship (marketplace labels exist once shipping is arranged). The document lists what has no label yet.
 */
const PRINTABLE = "ready_to_pack,packed,ready_to_ship";
const NONE: ReadonlySet<string> = new Set();

/**
 * L07 Cetak Label dan Antrean Cetak (DOKUMEN-UI-UX 14.2): orders whose labels are ready, the print settings,
 * one document for the selection (labels or packing lists, to an agent or as a PDF), the pick list on
 * screen, and what the agents are printing.
 */
export function LabelPrinting() {
  const t = useTranslations("shipping");
  const tCommon = useTranslations("common");
  const can = useCan();
  const [settings, setSettings] = usePrintSettings();
  const [selected, setSelected] = useState<ReadonlySet<string>>(NONE);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const document = useDocument(documentId);
  const orders = useInfiniteQuery({
    queryKey: ["orders", "list", { status: PRINTABLE, for: "labels" }],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/v1/orders", {
          params: {
            query: {
              status: PRINTABLE,
              sort: "ship_by",
              limit: PAGE,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = orders.data?.pages.flatMap((p) => p.items) ?? [];
  const ids = [...selected];
  const make = useMutation({
    mutationFn: (kind: "labels" | "packing_list") =>
      unwrap(
        api.POST("/v1/documents", {
          body: {
            kind,
            orderIds: ids,
            format: settings.format,
            template: settings.template,
            packingList: kind === "labels" && settings.packingList,
            ...(settings.deviceId ? { print: { deviceId: settings.deviceId, copies: 1 } } : {}),
          },
        }),
      ),
    onSuccess: (d) => setDocumentId(d.id),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  if (!can("shipment:print")) return <p className="text-text-500">{t("noPrintPermission")}</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="grid content-start gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox
            checked={rows.length > 0 && rows.every((o) => selected.has(o.id))}
            onCheckedChange={(v) => setSelected(v === true ? new Set(rows.map((o) => o.id)) : NONE)}
            aria-label={t("selectAllOrders")}
          />
          <span className="text-sm text-text-700">
            {selected.size > 0
              ? t("selectedOrders", { count: selected.size })
              : t("readyToPrint", { count: rows.length })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            disabled={selected.size === 0}
            onClick={() => setPicking(true)}
          >
            <ClipboardList aria-hidden />
            {t("pickList")}
          </Button>
        </div>
        <div className="rounded-[10px] border bg-surface">
          {orders.isPending ? (
            <div className="grid gap-2 p-4" aria-busy>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : orders.isError ? (
            <ErrorState error={orders.error} onRetry={() => orders.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState icon={Printer} title={t("noLabelsReady")} body={t("noLabelsReadyBody")} />
          ) : (
            <ul className="divide-y">
              {rows.map((o) => (
                <li key={o.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Checkbox
                    checked={selected.has(o.id)}
                    onCheckedChange={(v) => toggle(o.id, v === true)}
                    aria-label={t("selectOrder", { number: o.externalOrderId })}
                  />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-text-900">{o.externalOrderId}</span>
                      <StatusPill tone={STATUS_PILL[o.status].tone} icon={STATUS_PILL[o.status].icon}>
                        {o.statusLabel}
                      </StatusPill>
                    </span>
                    <span className="flex items-center gap-1.5 truncate text-[13px] text-text-500">
                      {o.store ? <ChannelIcon channel={o.store.channel} /> : null}
                      {[o.shippingProvider, o.trackingNumber].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {orders.hasNextPage ? (
          <Button
            variant="secondary"
            className="justify-self-center"
            loading={orders.isFetchingNextPage}
            onClick={() => orders.fetchNextPage()}
          >
            {tCommon("loadMore")}
          </Button>
        ) : null}
        <PrintQueue />
      </section>

      <aside className="grid content-start gap-3 rounded-[10px] border bg-surface p-4 lg:sticky lg:top-18">
        <h2 className="text-[15px] font-semibold text-text-900">{t("printSettings")}</h2>
        <PrintSettingsPanel settings={settings} onChange={setSettings} />
        <Button
          size="lg"
          disabled={selected.size === 0}
          loading={make.isPending && make.variables === "labels"}
          onClick={() => make.mutate("labels")}
        >
          <Printer aria-hidden />
          {t("makeLabels", { count: selected.size })}
        </Button>
        <Button
          variant="secondary"
          disabled={selected.size === 0}
          loading={make.isPending && make.variables === "packing_list"}
          onClick={() => make.mutate("packing_list")}
        >
          <FileText aria-hidden />
          {t("makePackingLists")}
        </Button>
        {document.data ? <DocumentResult document={document.data} /> : null}
      </aside>

      <PickListDialog orderIds={picking ? ids : null} onClose={() => setPicking(false)} />
    </div>
  );
}

/** "Daftar ambil" on screen (L05): units per SKU sorted by shelf, per warehouse, with what is missing. */
function PickListDialog({ orderIds, onClose }: { orderIds: string[] | null; onClose: () => void }) {
  const t = useTranslations("shipping");
  const pick = useQuery({
    queryKey: ["pick-list", orderIds],
    queryFn: () => unwrap(api.POST("/v1/pick-lists", { body: { orderIds: orderIds ?? [] } })),
    enabled: orderIds !== null && orderIds.length > 0,
  });
  return (
    <Dialog open={orderIds !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{t("pickListTitle")}</DialogTitle>
          <DialogDescription>{t("pickListBody", { count: orderIds?.length ?? 0 })}</DialogDescription>
        </DialogHeader>
        {pick.isPending ? (
          <Skeleton className="h-40" />
        ) : pick.isError ? (
          <ErrorState error={pick.error} onRetry={() => pick.refetch()} />
        ) : (
          <div className="grid gap-4">
            {pick.data.sections.map((s) => (
              <section key={s.warehouseId ?? "none"} className="grid gap-2">
                <h3 className="text-[15px] font-semibold text-text-900">
                  {s.warehouse} · {t("pickTotals", { orders: s.orders, units: s.units })}
                </h3>
                <ul className="divide-y rounded-lg border">
                  {s.lines.map((l) => (
                    <li key={`${l.variantId ?? l.sku}-${l.bin ?? ""}`} className="flex items-center gap-3 px-3 py-2">
                      <span className="w-20 shrink-0 font-mono text-[13px] text-text-700">{l.bin ?? "—"}</span>
                      <span className="grid min-w-0 flex-1">
                        <span className="font-mono text-sm text-text-900">{l.sku}</span>
                        <span className="truncate text-[13px] text-text-500">
                          {l.name}
                          {l.variantName ? ` · ${l.variantName}` : ""}
                        </span>
                      </span>
                      <span className="tabular text-xl font-bold text-text-900">{formatNumber(l.qty)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {pick.data.missing.length > 0 ? (
              <ul className="list-disc pl-5 text-[13px] text-danger">
                {pick.data.missing.map((m) => (
                  <li key={`${m.orderId}-${m.code}`}>{m.message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "Antrean cetak": recent print jobs of the agents, with a retry for what failed. */
function PrintQueue() {
  const t = useTranslations("shipping");
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const jobs = useQuery({
    queryKey: ["print-jobs"],
    queryFn: () => unwrap(api.GET("/v1/print-jobs", { params: { query: { limit: 20 } } })),
    refetchInterval: 10_000,
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "retry" | "cancel" }) =>
      action === "retry"
        ? unwrap(api.POST("/v1/print-jobs/{id}/retry", { params: { path: { id } } }))
        : unwrap(api.POST("/v1/print-jobs/{id}/cancel", { params: { path: { id } } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["print-jobs"] }),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const items = jobs.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className="grid gap-2 rounded-[10px] border bg-surface p-4">
      <h2 className="text-[15px] font-semibold text-text-900">{t("printQueue")}</h2>
      <ul className="divide-y">
        {items.map((j) => (
          <li key={j.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-text-900">{j.title}</span>
            <span className="text-[13px] text-text-500">{formatDateTime(j.createdAt, tz)}</span>
            <StatusPill tone={JOB_TONE[j.status]}>{t(`job_${j.status}`)}</StatusPill>
            {j.status === "failed" ? (
              <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: j.id, action: "retry" })}>
                <RotateCcw aria-hidden />
                {t("retryPrint")}
              </Button>
            ) : null}
            {j.status === "queued" ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("cancelPrint", { title: j.title })}
                onClick={() => act.mutate({ id: j.id, action: "cancel" })}
              >
                <X aria-hidden />
              </Button>
            ) : null}
            {j.error ? <span className="w-full text-[13px] text-danger">{j.error}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
