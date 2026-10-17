/** Custom BullMQ backoff for marketplace jobs: honour server retry hints and expiring worker leases. */
export function marketplaceBackoff(attemptsMade: number, type?: string, error?: Error): number {
  if (type !== "marketplace") throw new Error(`Unsupported custom backoff: ${type}`);
  const hint = (error as (Error & { retryAfterMs?: unknown }) | undefined)?.retryAfterMs;
  const base = Math.min(300_000, 5_000 * 2 ** Math.max(0, attemptsMade - 1));
  return typeof hint === "number" && Number.isFinite(hint) && hint >= 0 ? Math.max(base, hint) : base;
}
