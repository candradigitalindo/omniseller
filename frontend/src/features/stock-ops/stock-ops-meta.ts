import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type StockCount = components["schemas"]["StockCountDto_Output"];
export type CountStatus = StockCount["status"];
export type CountLine = components["schemas"]["StockCountLinePageDto_Output"]["items"][number];
export type LineFilter = "all" | "uncounted" | "counted" | "differences";
export type Transfer = components["schemas"]["StockTransferDto_Output"];
export type TransferStatus = Transfer["status"];

export const COUNT_TONE: Record<CountStatus, Tone> = {
  counting: "info",
  review: "warning",
  applied: "success",
  cancelled: "neutral",
};

export const TRANSFER_TONE: Record<TransferStatus, Tone> = {
  draft: "neutral",
  sent: "info",
  received: "success",
  cancelled: "neutral",
};

/** Share of the list counted so far, in whole percent. */
export function countedPercent(stats: Pick<StockCount["stats"], "lines" | "counted">): number {
  if (stats.lines === 0) return 0;
  return Math.floor((stats.counted / stats.lines) * 100);
}

/** Line filters a count offers now: differences stay hidden while a blind count is still counted. */
export function lineFilters(count: Pick<StockCount, "blind" | "status">): LineFilter[] {
  const hidden = count.blind && count.status === "counting";
  return hidden ? ["all", "uncounted", "counted"] : ["all", "uncounted", "counted", "differences"];
}

/**
 * Scans of one code close together become one request whose `qty` says how many: a scanner reads ten
 * units of one SKU in a few seconds, and one request per unit spends the business's 600 requests a
 * minute (backend 8.27). Another code, a pause, or `flush()` sends what is waiting.
 */
export class ScanBuffer {
  private code: string | null = null;
  private qty = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (code: string, qty: number) => void,
    private readonly pauseMs = 700,
  ) {}

  add(code: string, qty = 1): void {
    if (this.code !== null && this.code !== code) this.flush();
    this.code = code;
    this.qty += qty;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.pauseMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.code === null) return;
    const { code, qty } = this;
    this.code = null;
    this.qty = 0;
    this.send(code, qty);
  }

  /** What is waiting to be sent, for the screen. */
  get pending(): { code: string; qty: number } | null {
    return this.code === null ? null : { code: this.code, qty: this.qty };
  }
}

/**
 * Who may act on a transfer: the origin's people edit, send, and cancel it; the destination's people
 * receive it (backend 8.27). A user without a warehouse scope (`null`) is on both sides.
 */
export function transferSides(
  t: Pick<Transfer, "from" | "to">,
  warehouseScope: readonly string[] | null,
): { origin: boolean; destination: boolean } {
  const within = (id: string | undefined) =>
    warehouseScope === null || (id !== undefined && warehouseScope.includes(id));
  return { origin: within(t.from?.id), destination: within(t.to?.id) };
}

/**
 * The receipt body: only lines that did not arrive in full are listed, the api takes the rest as received
 * (`ReceiveStockTransferDto`).
 */
export function receiptLines(
  lines: readonly Pick<Transfer["lines"][number], "id" | "qty">[],
  received: Readonly<Record<string, number>>,
): { lineId: string; receivedQty: number }[] {
  return lines.flatMap((l) => {
    const got = received[l.id];
    return got === undefined || got === l.qty ? [] : [{ lineId: l.id, receivedQty: got }];
  });
}
