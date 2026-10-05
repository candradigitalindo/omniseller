"use client";

import { cn } from "cn";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { Tone } from "@/components/common/page";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPercentChange } from "@/lib/format";

export interface KpiChange {
  /** the change; null when there is nothing to compare with, which hides the line */
  pct: number | null;
  /** what it is compared with: "vs kemarin" */
  versus: string;
  /** how the change is written; percent with its sign by default */
  text?: string;
  /** a rise is bad news (the cancellation rate): red when it goes up, green when it goes down */
  invert?: boolean;
}

/**
 * A KPI tile (DOKUMEN-UI-UX 13.1, "berapa nilainya sekarang"): the number large, then its change with an
 * arrow and words, or a short note. `value` null shows a placeholder while it loads.
 */
export function KpiTile({
  label,
  value,
  change,
  note,
  href,
  tone,
}: {
  label: string;
  value: string | null;
  change?: KpiChange | undefined;
  note?: string | undefined;
  href?: string | undefined;
  tone?: Tone | undefined;
}) {
  const good = change && change.pct !== null ? (change.invert ? change.pct < 0 : change.pct > 0) : false;
  const bad = change && change.pct !== null ? (change.invert ? change.pct > 0 : change.pct < 0) : false;
  const body = (
    <Card className="h-full gap-1 transition-colors hover:border-border-strong">
      <CardContent className="grid gap-1">
        <span className="text-[13px] text-text-500">{label}</span>
        {value === null ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <span
            className={cn(
              "tabular text-[26px] leading-tight font-bold text-text-900 md:text-[28px]",
              tone === "warning" && "text-warning",
              tone === "danger" && "text-danger",
            )}
          >
            {value}
          </span>
        )}
        {change && change.pct !== null ? (
          <span
            className={cn(
              "flex flex-wrap items-center gap-1 text-[13px] font-medium",
              good ? "text-success" : bad ? "text-danger" : "text-text-500",
            )}
          >
            {change.pct > 0 ? <ArrowUpRight className="size-4" aria-hidden /> : null}
            {change.pct < 0 ? <ArrowDownRight className="size-4" aria-hidden /> : null}
            {change.text ?? formatPercentChange(change.pct)}{" "}
            <span className="font-normal text-text-500">{change.versus}</span>
          </span>
        ) : note ? (
          <span className="text-[13px] text-text-500">{note}</span>
        ) : null}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}
