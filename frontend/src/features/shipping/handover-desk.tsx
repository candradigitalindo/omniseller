"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { CheckCircle2, CircleAlert, FileText, ScanBarcode, Trash2, Truck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatDateTime, formatNumber, formatTime } from "@/lib/format";
import { useCan, useTimeZone } from "@/lib/session";
import { DocumentResult, PrintSettingsPanel, useDocument, usePrintSettings } from "./print-target";

/**
 * L08 Serah Terima Kurir (DOKUMEN-UI-UX 14.2): one open manifest per warehouse and courier; every parcel is
 * scanned into it, and completing it hands them over (manual orders ship) and prints the manifest with a
 * signature box for the courier.
 */
export function HandoverDesk() {
  const t = useTranslations("shipping");
  const can = useCan();
  const { params, set } = useUrlParams();
  const openId = params.get("manifest");
  if (!can("shipment:handover")) return <p className="text-text-500">{t("noHandoverPermission")}</p>;
  return openId ? (
    <Manifest id={openId} onClose={() => set({ manifest: null })} />
  ) : (
    <Start onOpen={(id) => set({ manifest: id })} />
  );
}

function Start({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useTranslations("shipping");
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const warehouses = useQuery({
    queryKey: ["stock", "warehouses"],
    queryFn: () => unwrap(api.GET("/v1/warehouses")),
    staleTime: 300_000,
  });
  const usable = warehouses.data?.items.filter((w) => w.active) ?? [];
  const [warehouseId, setWarehouseId] = useState("");
  const chosen = warehouseId || usable.find((w) => w.isDefault)?.id || usable[0]?.id || "";
  const couriers = useQuery({
    queryKey: ["handovers", "couriers", chosen],
    queryFn: () => unwrap(api.GET("/v1/handovers/couriers", { params: { query: { warehouseId: chosen } } })),
    enabled: chosen !== "",
  });
  const open = useQuery({
    queryKey: ["handovers", "list", "open"],
    queryFn: () => unwrap(api.GET("/v1/handovers", { params: { query: { status: "open" } } })),
  });
  const done = useQuery({
    queryKey: ["handovers", "list", "completed"],
    queryFn: () => unwrap(api.GET("/v1/handovers", { params: { query: { status: "completed" } } })),
  });
  const start = useMutation({
    mutationFn: (courier: string) => unwrap(api.POST("/v1/handovers", { body: { warehouseId: chosen, courier } })),
    onSuccess: (h) => {
      void queryClient.invalidateQueries({ queryKey: ["handovers"] });
      onOpen(h.id);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const openForCourier = (courier: string) =>
    open.data?.items.find((h) => h.warehouseId === chosen && h.courier === courier);

  return (
    <div className="grid gap-4">
      {usable.length > 1 ? (
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor="handover-warehouse">{t("warehouse")}</Label>
          <Select value={chosen} onValueChange={setWarehouseId}>
            <SelectTrigger id="handover-warehouse" className="w-full">
              <SelectValue />
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
      ) : null}
      <section className="grid gap-2">
        <h2 className="text-[15px] font-semibold text-text-900">{t("waitingCouriers")}</h2>
        {couriers.isPending ? (
          <Skeleton className="h-24" />
        ) : couriers.isError ? (
          <ErrorState error={couriers.error} onRetry={() => couriers.refetch()} />
        ) : couriers.data.items.length === 0 ? (
          <div className="rounded-[10px] border bg-surface">
            <EmptyState icon={Truck} title={t("noParcels")} body={t("noParcelsBody")} />
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {couriers.data.items.map((c) => {
              const name = c.courier ?? t("noCourier");
              const existing = c.courier ? openForCourier(c.courier) : undefined;
              return (
                <li key={name} className="grid gap-2 rounded-[10px] border bg-surface p-4">
                  <span className="text-base font-semibold text-text-900">{name}</span>
                  <span className="tabular text-2xl font-bold text-text-900">{t("parcels", { count: c.parcels })}</span>
                  {c.courier ? (
                    existing ? (
                      <Button variant="secondary" onClick={() => onOpen(existing.id)}>
                        {t("continueManifest", { number: existing.number })}
                      </Button>
                    ) : (
                      <Button
                        loading={start.isPending && start.variables === c.courier}
                        onClick={() => start.mutate(c.courier!)}
                      >
                        {t("openManifest")}
                      </Button>
                    )
                  ) : (
                    <span className="text-[13px] text-text-500">{t("noCourierHint")}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {done.data && done.data.items.length > 0 ? (
        <section className="grid gap-2">
          <h2 className="text-[15px] font-semibold text-text-900">{t("manifestHistory")}</h2>
          <ul className="divide-y rounded-[10px] border bg-surface">
            {done.data.items.slice(0, 10).map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-surface-2"
                  onClick={() => onOpen(h.id)}
                >
                  <span className="font-mono text-text-900">{h.number}</span>
                  <span className="text-text-700">
                    {h.courier} · {t("parcels", { count: h.parcels })}
                  </span>
                  {h.receivedBy ? (
                    <span className="text-text-500">{t("receivedByShort", { name: h.receivedBy })}</span>
                  ) : null}
                  <span className="ml-auto text-[13px] text-text-500">
                    {h.completedAt ? formatDateTime(h.completedAt, tz) : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

type Flash = { ok: boolean; text: string };

function Manifest({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("shipping");
  const tz = useTimeZone();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [flash, setFlash] = useState<Flash | null>(null);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const document = useDocument(documentId);
  const manifest = useQuery({
    queryKey: ["handovers", "detail", id],
    queryFn: () => unwrap(api.GET("/v1/handovers/{id}", { params: { path: { id } } })),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["handovers"] });
  const scan = useMutation({
    mutationFn: (value: string) =>
      unwrap(api.POST("/v1/handovers/{id}/scan", { params: { path: { id } }, body: { code: value } })),
    onSuccess: (r) => {
      setFlash({
        ok: !r.duplicate,
        text: r.duplicate
          ? t("alreadyScanned", { tracking: r.item.trackingNumber })
          : t("parcelScanned", { tracking: r.item.trackingNumber, number: r.item.orderNumber }),
      });
      refresh();
    },
    onError: (error, value) => setFlash({ ok: false, text: `${value}: ${errorMessage(error)}` }),
  });
  const remove = useMutation({
    mutationFn: (itemId: string) =>
      unwrap(api.DELETE("/v1/handovers/{id}/items/{itemId}", { params: { path: { id, itemId } } })),
    onSuccess: refresh,
    onError: (error) => toast.error(errorMessage(error)),
  });
  // an open manifest given up: its parcels can go into another one
  const cancel = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/handovers/{id}/cancel", { params: { path: { id } } })),
    onSuccess: (h) => {
      toast.success(t("manifestCancelled", { number: h.number }));
      setCancelling(false);
      refresh();
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const manifestPdf = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/handovers/{id}/manifest", { params: { path: { id } }, body: {} })),
    onSuccess: (r) => setDocumentId(r.document.id),
    onError: (error) => toast.error(errorMessage(error)),
  });
  useEffect(() => {
    input.current?.focus();
  }, []);
  if (manifest.isPending) return <Skeleton className="h-64" />;
  if (manifest.isError) return <ErrorState error={manifest.error} onRetry={() => manifest.refetch()} />;
  const h = manifest.data;
  const isOpen = h.status === "open";

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg font-semibold text-text-900">{h.number}</span>
            <StatusPill tone={isOpen ? "info" : h.status === "completed" ? "success" : "neutral"}>
              {t(`handover_${h.status}`)}
            </StatusPill>
          </span>
          <span className="text-text-700">{h.courier}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("backToCouriers")}
          </Button>
          {isOpen ? (
            <Button variant="secondary" className="text-danger" onClick={() => setCancelling(true)}>
              {t("cancelManifest")}
            </Button>
          ) : null}
          {!isOpen ? (
            <Button variant="secondary" loading={manifestPdf.isPending} onClick={() => manifestPdf.mutate()}>
              <FileText aria-hidden />
              {t("manifestPdf")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="grid content-start gap-3">
          {isOpen ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const value = code.trim();
                if (!value) return;
                setCode("");
                scan.mutate(value);
              }}
            >
              <div className="relative flex-1">
                <ScanBarcode
                  className="pointer-events-none absolute top-1/2 left-4 size-6 -translate-y-1/2 text-text-500"
                  aria-hidden
                />
                <Input
                  ref={input}
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t("scanTracking")}
                  aria-label={t("scanTracking")}
                  className="h-16 pl-13 text-lg md:h-16 md:text-lg"
                />
              </div>
            </form>
          ) : null}
          {flash ? (
            <p
              role={flash.ok ? "status" : "alert"}
              className={cn(
                "flex items-start gap-2 rounded-[10px] px-4 py-3 text-base font-medium",
                flash.ok ? "bg-success-soft text-text-900" : "bg-danger-soft text-danger",
              )}
            >
              {flash.ok ? (
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
              )}
              {flash.text}
            </p>
          ) : null}
          <div className="grid justify-items-center gap-1 rounded-[10px] border bg-surface p-6">
            <span className="tabular text-5xl font-bold text-text-900">{formatNumber(h.parcels)}</span>
            <span className="text-text-500">{t("parcelsScanned")}</span>
          </div>
          {isOpen ? (
            <Button size="lg" className="h-14 text-base" disabled={h.parcels === 0} onClick={() => setCompleting(true)}>
              {t("completeHandover", { courier: h.courier, count: h.parcels })}
            </Button>
          ) : null}
          {h.receivedBy ? <p className="text-sm text-text-700">{t("receivedBy", { name: h.receivedBy })}</p> : null}
          {document.data ? <DocumentResult document={document.data} /> : null}
        </section>
        <section className="rounded-[10px] border bg-surface">
          {h.items.length === 0 ? (
            <EmptyState icon={ScanBarcode} title={t("noScansYet")} />
          ) : (
            <ul className="divide-y">
              {[...h.items].reverse().map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="font-mono text-sm text-text-900">{i.trackingNumber}</span>
                    <span className="text-[13px] text-text-500">{i.orderNumber}</span>
                  </span>
                  <span className="text-[13px] text-text-500">{formatTime(i.scannedAt, tz)}</span>
                  {isOpen ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("removeParcel", { tracking: i.trackingNumber })}
                      onClick={() => remove.mutate(i.id)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("cancelManifestTitle", { number: h.number })}</DialogTitle>
            <DialogDescription>{t("cancelManifestBody", { count: h.parcels })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCancelling(false)}>
              {t("keepManifest")}
            </Button>
            <Button variant="destructive" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              {t("cancelManifest")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CompleteDialog
        open={completing}
        handoverId={h.id}
        courier={h.courier}
        parcels={h.parcels}
        onClose={() => setCompleting(false)}
        onDone={(docId) => {
          setCompleting(false);
          setDocumentId(docId);
          refresh();
        }}
      />
    </div>
  );
}

function CompleteDialog({
  open,
  handoverId,
  courier,
  parcels,
  onClose,
  onDone,
}: {
  open: boolean;
  handoverId: string;
  courier: string;
  parcels: number;
  onClose: () => void;
  onDone: (documentId: string | null) => void;
}) {
  const t = useTranslations("shipping");
  const tCommon = useTranslations("common");
  const [receivedBy, setReceivedBy] = useState("");
  const [settings, setSettings] = usePrintSettings();
  const complete = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/handovers/{id}/complete", {
          params: { path: { id: handoverId } },
          body: {
            receivedBy: receivedBy.trim() || null,
            ...(settings.deviceId ? { print: { deviceId: settings.deviceId, copies: 1 } } : {}),
          },
        }),
      ),
    onSuccess: (r) => {
      toast.success(t("handoverDone", { count: r.handover.parcels, courier }));
      onDone(r.document?.id ?? null);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t("completeTitle", { courier, count: parcels })}</DialogTitle>
          <DialogDescription>{t("completeBody")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="received-by">{t("courierName")}</Label>
          <Input id="received-by" maxLength={100} value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} />
        </div>
        <PrintSettingsPanel settings={settings} onChange={setSettings} showLabelOptions={false} />
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button loading={complete.isPending} onClick={() => complete.mutate()}>
            {t("completeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
