"use client";

import { useMutation } from "@tanstack/react-query";
import { cn } from "cn";
import { CheckCircle2, CircleAlert, PackageCheck, Plus, Printer, ScanBarcode, Settings2 } from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { StatusPill } from "@/components/common/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { formatNumber } from "@/lib/format";
import { useCan } from "@/lib/session";
import { PrintSettingsPanel, usePrintAgents, usePrintSettings } from "./print-target";
import { type PackingView, packed, packingScans, packSeconds, scanUnit } from "./shipping-meta";

type Flash = { tone: "success" | "danger" | "warning"; text: string };
const NEXT_ORDER_MS = 1_500;

/**
 * L06 Kemas dengan Scan (DOKUMEN-UI-UX 14.2): scan the order or its tracking number, then every unit; the
 * order is packed only when each line has exactly its units, and its label can go to the printer at once.
 */
export function PackStation() {
  const t = useTranslations("shipping");
  const can = useCan();
  const [view, setView] = useState<PackingView | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [flash, setFlash] = useState<Flash | null>(null);
  const [code, setCode] = useState("");
  const [settings, setSettings] = usePrintSettings();
  const agents = usePrintAgents();
  const input = useRef<HTMLInputElement>(null);
  // when the order was scanned, on the station's own clock: the packing time the team report averages
  const startedAt = useRef<number | null>(null);
  const agent = agents.data?.items.find((a) => a.id === settings.deviceId) ?? null;

  const reset = () => {
    setView(null);
    setCounts({});
    startedAt.current = null;
    setCode("");
    input.current?.focus();
  };
  const lookup = useMutation({
    mutationFn: (value: string) => unwrap(api.GET("/v1/packing/lookup", { params: { query: { code: value } } })),
    onSuccess: (v) => {
      setView(v);
      setCounts({});
      startedAt.current = performance.now();
      input.current?.focus();
      setFlash(v.packable ? null : { tone: "danger", text: v.packRefusal?.message ?? t("notPackable") });
    },
    onError: (error) => setFlash({ tone: "danger", text: errorMessage(error) }),
  });
  const complete = useMutation({
    mutationFn: (print: boolean) =>
      unwrap(
        api.POST("/v1/packing/orders/{id}/complete", {
          params: { path: { id: view?.order.id ?? "" } },
          body: {
            scans: packingScans(view?.lines ?? [], counts),
            ...(startedAt.current !== null ? { seconds: packSeconds(startedAt.current, performance.now()) } : {}),
            ...(print && settings.deviceId
              ? {
                  print: {
                    deviceId: settings.deviceId,
                    copies: 1,
                    format: settings.format,
                    template: settings.template,
                    packingList: settings.packingList,
                  },
                }
              : {}),
          },
        }),
      ),
    onSuccess: (r) => {
      const printed = r.printJob ? ` ${t("labelQueuedTo", { agent: agent?.name ?? "" })}` : "";
      const refused = r.printRefusal ? ` ${r.printRefusal.message}` : "";
      setFlash({
        tone: r.printRefusal ? "warning" : "success",
        text: `${t("packedDone", { number: r.order.number })}${printed}${refused}`,
      });
      setTimeout(reset, NEXT_ORDER_MS);
    },
    onError: (error) => setFlash({ tone: "danger", text: errorMessage(error) }),
  });

  const submitCode = (value: string) => {
    const c = value.trim();
    if (!c) return;
    setCode("");
    if (!view) {
      lookup.mutate(c);
      return;
    }
    if (!view.packable) return;
    const r = scanUnit(view.lines, counts, c);
    setCounts(r.counts);
    if (r.outcome === "unknown") setFlash({ tone: "danger", text: t("notInOrder", { code: c }) });
    else if (r.outcome === "complete")
      setFlash({ tone: "warning", text: t("lineComplete", { name: r.line?.name ?? c }) });
    else {
      const got = r.counts[r.line!.key] ?? 0;
      setFlash({ tone: "success", text: t("unitCounted", { name: r.line!.name, got, qty: r.line!.qty }) });
    }
  };
  const done = view ? packed(view.lines, counts) : false;
  const canPrint = can("shipment:print") && settings.deviceId !== "" && view?.labelRefusal === null;

  if (!can("shipment:pack")) return <p className="text-text-500">{t("noPackPermission")}</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <section className="grid content-start gap-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submitCode(code);
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
              placeholder={view ? t("scanItem") : t("scanOrder")}
              aria-label={view ? t("scanItem") : t("scanOrder")}
              className="h-16 pl-13 text-lg md:h-16 md:text-lg"
            />
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon-lg"
                className="size-16"
                aria-label={t("printSettings")}
              >
                <Settings2 aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <PrintSettingsPanel settings={settings} onChange={setSettings} />
            </PopoverContent>
          </Popover>
        </form>
        {flash ? (
          <p
            role={flash.tone === "danger" ? "alert" : "status"}
            className={cn(
              "flex items-start gap-2 rounded-[10px] px-4 py-3 text-lg font-medium",
              flash.tone === "success" && "bg-success-soft text-text-900",
              flash.tone === "warning" && "bg-warning-soft text-text-900",
              flash.tone === "danger" && "bg-danger-soft text-danger",
            )}
          >
            {flash.tone === "danger" ? (
              <CircleAlert className="mt-1 size-5 shrink-0" aria-hidden />
            ) : (
              <CheckCircle2
                className={cn("mt-1 size-5 shrink-0", flash.tone === "success" ? "text-success" : "text-warning")}
                aria-hidden
              />
            )}
            {flash.text}
          </p>
        ) : null}
        {view ? (
          <div className="grid gap-2 rounded-[10px] border bg-surface p-4 text-base">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-lg font-semibold text-text-900">{view.order.number}</span>
              <StatusPill tone="info">{view.order.statusLabel}</StatusPill>
            </span>
            <span className="text-text-700">
              {[view.order.courier, view.order.trackingNumber].filter(Boolean).join(" · ") || t("noCourierYet")}
            </span>
            {view.order.note ? (
              <span className="rounded-lg bg-warning-soft px-3 py-2 text-text-900">{view.order.note}</span>
            ) : null}
            {view.labelRefusal ? <span className="text-[15px] text-warning">{view.labelRefusal.message}</span> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {canPrint ? (
                <Button
                  size="lg"
                  className="h-14 flex-1 text-base"
                  disabled={!done}
                  loading={complete.isPending && complete.variables === true}
                  onClick={() => complete.mutate(true)}
                >
                  <Printer aria-hidden />
                  {t("packAndPrint")}
                </Button>
              ) : null}
              <Button
                size="lg"
                variant={canPrint ? "secondary" : "default"}
                className="h-14 flex-1 text-base"
                disabled={!done || !view.packable}
                loading={complete.isPending && complete.variables === false}
                onClick={() => complete.mutate(false)}
              >
                <PackageCheck aria-hidden />
                {t("markPacked")}
              </Button>
            </div>
            <Button variant="ghost" className="justify-self-start" onClick={reset}>
              {t("otherOrder")}
            </Button>
          </div>
        ) : (
          <p className="text-[15px] text-text-500">{t("scanOrderHint")}</p>
        )}
      </section>

      {view ? (
        <ul className="grid content-start gap-3 sm:grid-cols-2">
          {view.lines.map((l) => {
            const got = counts[l.key] ?? 0;
            const full = got === l.qty;
            return (
              <li
                key={l.key}
                className={cn(
                  "flex gap-3 rounded-[10px] border-2 bg-surface p-3",
                  full ? "border-success bg-success-soft" : "border-border",
                )}
              >
                {l.imageUrl ? (
                  <Image
                    src={l.imageUrl}
                    alt=""
                    width={80}
                    height={80}
                    unoptimized
                    className="size-20 shrink-0 rounded-lg border object-cover"
                  />
                ) : (
                  <span className="size-20 shrink-0 rounded-lg bg-surface-2" aria-hidden />
                )}
                <div className="grid min-w-0 flex-1 content-start gap-1">
                  <span className="line-clamp-2 text-base font-semibold text-text-900">{l.name}</span>
                  {l.variantName ? <span className="text-[15px] text-text-700">{l.variantName}</span> : null}
                  <span className="truncate font-mono text-sm text-text-700">{l.sku}</span>
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn("tabular text-2xl font-bold", full ? "text-success" : "text-text-900")}>
                      <span aria-hidden>
                        {formatNumber(got)}/{formatNumber(l.qty)}
                      </span>
                      <span className="sr-only">{t("countOf", { got, qty: l.qty })}</span>
                    </span>
                    {view.packable && !full ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={t("addOne", { name: l.name })}
                        onClick={() => submitCode(l.key)}
                      >
                        <Plus aria-hidden />1
                      </Button>
                    ) : null}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
