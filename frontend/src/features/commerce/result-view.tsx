"use client";

import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTime, formatNumber, formatRupiah } from "@/lib/format";
import { useTimeZone } from "@/lib/session";
import { useCommerceLabel } from "./labels";

const sensitiveKey = /(?:token|secret|cipher|password|apikey|appkey|authorizationcode|authcode)/i;
const humanLabel = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
const objectValue = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Nested marketplace data is presented as named values and paged items, never a raw JSON editor. */
export function CommerceResultView({ value, title }: { value: unknown; title?: string }) {
  const t = useTranslations("commerce");
  const label = useCommerceLabel();
  const zone = useTimeZone();
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ title: string; value: unknown }>();
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [t("resultItem", { count: index + 1 }), item])
    : objectValue(value)
      ? Object.entries(value).filter(([key]) => !sensitiveKey.test(key.replace(/[^a-z0-9]/gi, "")))
      : [[title ?? t("resultValue"), value]];
  const pageEntries = entries.slice(page * 3, page * 3 + 3);
  const renderValue = (key: string, item: unknown) => {
    if (item === null || item === undefined || item === "")
      return <span className="text-text-500">{t("noValue")}</span>;
    if (typeof item === "boolean") return t(item ? "yes" : "no");
    if (
      objectValue(value) &&
      value.currency === "IDR" &&
      /(?:^|_)(?:amount|price|fee|cost|budget|total)$/.test(key) &&
      (typeof item === "number" || typeof item === "string") &&
      item !== "" &&
      Number.isFinite(Number(item))
    )
      return formatRupiah(Number(item));
    if (
      objectValue(item) &&
      item.currency === "IDR" &&
      (typeof item.amount === "string" || typeof item.amount === "number") &&
      Number.isFinite(Number(item.amount))
    )
      return formatRupiah(Number(item.amount));
    const timestamp =
      typeof item === "number" ? item : typeof item === "string" && /^\d+$/.test(item) ? Number(item) : 0;
    if (
      /(?:At|_at|_time|_timestamp|timestamp)$/.test(key) &&
      timestamp > 1_000_000_000 &&
      timestamp < 100_000_000_000_000
    )
      return formatDateTime(new Date(timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1000), zone);
    if (
      typeof item === "string" &&
      /(?:At|_at|_time|_date)$/.test(key) &&
      /^\d{4}-\d{2}-\d{2}T/.test(item) &&
      !Number.isNaN(Date.parse(item))
    )
      return formatDateTime(item, zone);
    if (typeof item === "number") return /(?:^id$|_id$|Id$)/.test(key) ? String(item) : formatNumber(item);
    if (typeof item === "string") return <span className="line-clamp-3 break-all">{item}</span>;
    if (Array.isArray(item) || objectValue(item))
      return (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="max-w-full"
          onClick={() => setSelected({ title: label(humanLabel(key)), value: item })}
        >
          <span className="truncate">
            {Array.isArray(item) ? t("showItems", { count: item.length }) : t("showDetails")}
          </span>
          <ChevronRight aria-hidden />
        </Button>
      );
    return t("noValue");
  };
  return (
    <div className="grid min-w-0 gap-3">
      {!entries.length ? (
        <p className="rounded-xl bg-surface-2 p-3 text-sm text-text-500">{t("emptyResult")}</p>
      ) : (
        <dl className="grid gap-2">
          {pageEntries.map(([key, item]) => (
            <div key={key} className="grid min-w-0 gap-1 rounded-xl border bg-surface p-3">
              <dt className="text-xs font-medium text-text-500">{label(humanLabel(key))}</dt>
              <dd className="min-w-0 text-sm text-text-900">{renderValue(key, item)}</dd>
            </div>
          ))}
        </dl>
      )}
      {entries.length > 3 ? (
        <div className="flex items-center justify-between gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
            {t("previous")}
          </Button>
          <span className="text-xs text-text-500">{t("page", { count: page + 1 })}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={(page + 1) * 3 >= entries.length}
            onClick={() => setPage(page + 1)}
          >
            {t("next")}
          </Button>
        </div>
      ) : null}
      {selected ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelected(undefined);
          }}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="break-words leading-snug">{selected.title}</DialogTitle>
              <DialogDescription>{t("resultDescription")}</DialogDescription>
            </DialogHeader>
            <CommerceResultView key={selected.title} value={selected.value} title={selected.title} />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
