import { cn } from "cn";

/**
 * Marketplace marks only as small icons next to a store name, never coloring OmniSeller's own parts (4.4).
 * TikTok Shop is "Tokopedia & Shop" in Indonesia (PRD 5.6); its brand is not shown.
 */
const CHANNELS: Record<string, { label: string; initial: string; className: string }> = {
  shopee: { label: "Shopee", initial: "S", className: "bg-[#ee4d2d] text-white" },
  tiktokshop: { label: "Tokopedia & Shop", initial: "T", className: "bg-[#03ac0e] text-white" },
  lazada: { label: "Lazada", initial: "L", className: "bg-[#0f146d] text-white" },
  blibli: { label: "Blibli", initial: "B", className: "bg-[#0095da] text-white" },
  manual: { label: "Penjualan langsung", initial: "M", className: "bg-text-500 text-surface" },
  shopify: { label: "Shopify", initial: "S", className: "bg-text-500 text-surface" },
  woocommerce: { label: "WooCommerce", initial: "W", className: "bg-text-500 text-surface" },
};

export function channelLabel(channel: string): string {
  return CHANNELS[channel]?.label ?? channel;
}

/**
 * The channel's mark. `decorative` when its name is written next to it, so screen readers do not hear the
 * name twice.
 */
export function ChannelIcon({
  channel,
  className,
  decorative,
}: {
  channel: string;
  className?: string;
  decorative?: boolean;
}) {
  const c = CHANNELS[channel] ?? {
    label: channel,
    initial: channel.slice(0, 1).toUpperCase(),
    className: "bg-text-500 text-surface",
  };
  return (
    <span
      title={decorative ? undefined : c.label}
      aria-hidden={decorative || undefined}
      className={cn(
        "inline-grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-bold",
        c.className,
        className,
      )}
    >
      <span aria-hidden>{c.initial}</span>
      {decorative ? null : <span className="sr-only">{c.label}</span>}
    </span>
  );
}

/** Chart slot per channel (13.2): an entity keeps its color in every chart. */
export function channelChartSlot(channel: string): number {
  return { lazada: 1, shopee: 2, tiktokshop: 3, manual: 4, blibli: 7 }[channel] ?? 5;
}
