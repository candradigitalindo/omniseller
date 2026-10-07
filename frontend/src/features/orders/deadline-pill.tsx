"use client";

import { Truck } from "lucide-react";
import { useTranslations } from "next-intl";
import { SlaPill, StatusPill } from "@/components/common/page";
import { formatDayMonth, formatRemaining, formatTime } from "@/lib/format";
import { useTimeZone } from "@/lib/session";
import { missedPickup, type OrderListItem, pickupAhead } from "./order-meta";

/** "15.00" today, "6 Okt 15.00" another day. */
function pickupTime(at: string, timeZone: string): string {
  const day = (d: string) => new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(new Date(d));
  const time = formatTime(at, timeZone);
  return day(at) === day(new Date().toISOString()) ? time : `${formatDayMonth(at, timeZone)} ${time}`;
}

/**
 * The deadline an order is worked to (UI L03, backend doc 8.31): the courier's pickup when it comes first
 * ("Pickup 15.00 · 2 jam"), else the marketplace's, with a note when the pickup was missed.
 */
export function DeadlinePill({
  order: o,
  empty = null,
}: {
  order: Pick<OrderListItem, "shipByAt" | "sla" | "internalShipByAt" | "internalSla">;
  empty?: React.ReactNode;
}) {
  const t = useTranslations("orders");
  const tz = useTimeZone();
  const pickup = pickupAhead(o);
  if (pickup) {
    return (
      <StatusPill tone={pickup.state === "warning" ? "warning" : "info"} icon={Truck}>
        {t("pickupIn", { time: pickupTime(pickup.at, tz), remaining: formatRemaining(pickup.remainingMs) })}
      </StatusPill>
    );
  }
  const missed = missedPickup(o);
  if (!o.sla && !missed) return <>{empty}</>;
  return (
    <span className="inline-grid justify-items-start gap-1">
      {o.sla ? <SlaPill sla={o.sla} /> : null}
      {missed ? (
        <span className="text-[13px] font-medium text-warning">
          {t("pickupMissed", { time: pickupTime(missed, tz) })}
        </span>
      ) : null}
    </span>
  );
}
