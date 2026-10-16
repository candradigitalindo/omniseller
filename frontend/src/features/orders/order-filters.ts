import type { operations } from "@/lib/api/schema";
import { zonedToIso } from "./manual-order-meta";

type Query = NonNullable<operations["OrdersController_list"]["parameters"]["query"]>;
export const ORDER_CHANNELS = [
  "shopee",
  "tiktokshop",
  "lazada",
  "blibli",
  "shopify",
  "woocommerce",
  "manual",
] as const satisfies readonly NonNullable<Query["channel"]>[];

export function orderChannel(value: string | null): Query["channel"] | null {
  return ORDER_CHANNELS.find((channel) => channel === value) ?? null;
}

/** A real calendar date from a shared URL, without allowing Date to normalize impossible days. */
export function orderDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0100-01-01" || value > "9998-12-31") return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/** Inclusive calendar dates become a half-open interval on the business's clock, including DST days. */
export function orderPeriod(from: string | null, to: string | null, timeZone: string) {
  const nextDay = to ? new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
  return {
    from: from ? zonedToIso(from, timeZone) : undefined,
    to: nextDay ? zonedToIso(nextDay, timeZone) : undefined,
  };
}
