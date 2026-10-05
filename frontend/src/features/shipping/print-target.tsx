"use client";

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, unwrap } from "@/lib/api/client";
import { useCan } from "@/lib/session";
import {
  DEFAULT_PRINT,
  type DocumentView,
  documentDone,
  loadPrintSettings,
  type PrintSettings,
  savePrintSettings,
} from "./shipping-meta";

const DOWNLOAD = "download";
const POLL_MS = 2_000;

/** The print agents of the business, with whether each reported in the last two minutes (backend 8.24). */
export function usePrintAgents() {
  const can = useCan();
  return useQuery({
    queryKey: ["print-agents"],
    queryFn: () => unwrap(api.GET("/v1/print-agents")),
    enabled: can("shipment:print"),
    refetchInterval: 60_000,
  });
}

/** Print choices remembered per browser (each packing PC has its own printer). */
export function usePrintSettings(): [PrintSettings, (patch: Partial<PrintSettings>) => void] {
  const [settings, setSettings] = useState<PrintSettings>(DEFAULT_PRINT);
  useEffect(() => setSettings(loadPrintSettings()), []);
  const update = (patch: Partial<PrintSettings>) =>
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      savePrintSettings(next);
      return next;
    });
  return [settings, update];
}

/** Follows a PDF the worker renders until it is ready (a download link) or failed. */
export function useDocument(id: string | null) {
  return useQuery({
    queryKey: ["documents", id],
    queryFn: () => unwrap(api.GET("/v1/documents/{id}", { params: { path: { id: id ?? "" } } })),
    enabled: id !== null,
    refetchInterval: (q) => (documentDone(q.state.data) ? false : POLL_MS),
  });
}

/**
 * Where documents go (L07, "Pengaturan cetak"): a print agent with its status, or a PDF to download; label
 * format, template, and the packing list after each label.
 */
export function PrintSettingsPanel({
  settings,
  onChange,
  showLabelOptions = true,
  className,
}: {
  settings: PrintSettings;
  onChange: (patch: Partial<PrintSettings>) => void;
  showLabelOptions?: boolean;
  className?: string;
}) {
  const t = useTranslations("shipping");
  const agents = usePrintAgents();
  const list = agents.data?.items ?? [];
  const chosen = list.find((a) => a.id === settings.deviceId);
  return (
    <div className={cn("grid gap-3", className)}>
      <div className="grid gap-1.5">
        <Label htmlFor="print-target">{t("printTarget")}</Label>
        <Select
          value={chosen ? chosen.id : DOWNLOAD}
          onValueChange={(v) => onChange({ deviceId: v === DOWNLOAD ? "" : v })}
        >
          <SelectTrigger id="print-target" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DOWNLOAD}>{t("downloadPdf")}</SelectItem>
            {list.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name} · {a.connected ? t("agentOnline") : t("agentOffline")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {chosen && !chosen.connected ? <p className="text-[13px] text-warning">{t("agentOfflineHint")}</p> : null}
        {list.length === 0 && agents.isSuccess ? <p className="text-[13px] text-text-500">{t("noAgents")}</p> : null}
      </div>
      {showLabelOptions ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="print-format">{t("format")}</Label>
            <Select value={settings.format} onValueChange={(v) => onChange({ format: v === "a4" ? "a4" : "thermal" })}>
              <SelectTrigger id="print-format" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="thermal">{t("formatThermal")}</SelectItem>
                <SelectItem value="a4">{t("formatA4")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="print-template">{t("template")}</Label>
            <Select
              value={settings.template}
              onValueChange={(v) => onChange({ template: v === "custom" ? "custom" : "standard" })}
            >
              <SelectTrigger id="print-template" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">{t("templateStandard")}</SelectItem>
                <SelectItem value="custom">{t("templateCustom")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="print-packing-list" className="font-normal">
              {t("withPackingList")}
            </Label>
            <Switch
              id="print-packing-list"
              checked={settings.packingList}
              onCheckedChange={(v) => onChange({ packingList: v })}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** A rendered document: its download link once ready, what is missing from it, or why it failed. */
export function DocumentResult({ document: d }: { document: DocumentView }) {
  const t = useTranslations("shipping");
  if (d.status === "failed") {
    return (
      <p className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">{d.error ?? t("documentFailed")}</p>
    );
  }
  if (d.status !== "ready") {
    return (
      <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-text-700" aria-live="polite">
        {t("documentRendering")}
      </p>
    );
  }
  return (
    <div className="grid gap-2 rounded-lg bg-success-soft px-3 py-2.5 text-sm text-text-900">
      <p>{t("documentReady", { pages: d.pageCount ?? 0 })}</p>
      {d.printJob ? (
        <p className="text-[13px] text-text-700">{t("sentToPrinter", { title: d.printJob.title })}</p>
      ) : null}
      {d.downloadUrl ? (
        <a href={d.downloadUrl} target="_blank" rel="noopener" className="font-medium text-primary hover:underline">
          {t("download")}
        </a>
      ) : null}
      {d.result.missing.length > 0 ? (
        <div className="grid gap-1 text-[13px] text-danger">
          <span className="font-medium">{t("missingLabels", { count: d.result.missing.length })}</span>
          <ul className="list-disc pl-5">
            {d.result.missing.slice(0, 10).map((m) => (
              <li key={`${m.orderId ?? m.variantId}-${m.code}`}>{m.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
