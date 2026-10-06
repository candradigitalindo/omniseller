"use client";

import { useMutation } from "@tanstack/react-query";
import { cn } from "cn";
import { CheckCircle2, ScanLine, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { usePrintAgents } from "./print-target";
import type { PrintSettings } from "./shipping-meta";

/** The scans shown under the box, newest first. */
const SHOWN = 8;

type Outcome = { key: number; code: string; ok: boolean; title: string; detail: string | null };

/**
 * "Scan untuk cetak" (L07, backend 8.24): scan an order number or a tracking number and its label prints on
 * this station's agent at once, with the station's format, template, and packing list. A label that cannot
 * print yet says why. Needs an agent: the box stays off while the station downloads PDFs.
 */
export function ScanToPrint({ settings }: { settings: PrintSettings }) {
  const t = useTranslations("shipping");
  const agents = usePrintAgents();
  const agent = (agents.data?.items ?? []).find((a) => a.id === settings.deviceId) ?? null;
  const [code, setCode] = useState("");
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const add = (o: Omit<Outcome, "key">) =>
    setOutcomes((all) => [{ ...o, key: (all[0]?.key ?? 0) + 1 }, ...all].slice(0, SHOWN));
  const scan = useMutation({
    mutationFn: (value: string) =>
      unwrap(
        api.POST("/v1/print-jobs/scan", {
          body: {
            deviceId: settings.deviceId,
            code: value,
            copies: 1,
            format: settings.format,
            template: settings.template,
            packingList: settings.packingList,
          },
        }),
      ),
    onSuccess: (r, value) =>
      add({
        code: value,
        ok: true,
        title: t("scanPrinted", { number: r.order.number }),
        detail: [r.order.courier, r.order.trackingNumber].filter(Boolean).join(" · ") || null,
      }),
    onError: (error, value) => add({ code: value, ok: false, title: value, detail: errorMessage(error) }),
  });
  const ready = settings.deviceId !== "" && agent !== null;

  return (
    <section className="grid gap-3 rounded-[10px] border bg-surface p-4" aria-labelledby="scan-print-title">
      <div className="grid gap-0.5">
        <h2 id="scan-print-title" className="flex items-center gap-2 text-[15px] font-semibold text-text-900">
          <ScanLine className="size-5 text-primary" aria-hidden />
          {t("scanPrintTitle")}
        </h2>
        <p className="text-sm text-text-700">
          {ready ? t("scanPrintBody", { agent: agent.name }) : t("scanPrintNeedsAgent")}
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const value = code.trim();
          if (!value) return;
          setCode("");
          scan.mutate(value);
        }}
      >
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={!ready}
          placeholder={t("scanPrintPlaceholder")}
          aria-label={t("scanPrintPlaceholder")}
          autoComplete="off"
          className="h-12 font-mono text-base"
        />
      </form>
      {outcomes.length > 0 ? (
        <ul className="grid gap-1.5" aria-label={t("scanPrintResults")} aria-live="polite">
          {outcomes.map((o) => (
            <li
              key={o.key}
              className={cn(
                "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
                o.ok ? "bg-success-soft text-text-900" : "bg-danger-soft text-text-900",
              )}
            >
              {o.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              ) : (
                <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
              )}
              <span className="grid min-w-0 gap-0.5">
                <span className={cn("font-medium", !o.ok && "font-mono")}>{o.title}</span>
                {o.detail ? <span className="text-[13px] text-text-700">{o.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
