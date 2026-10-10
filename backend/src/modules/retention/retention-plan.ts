/**
 * Buyer data retention as pure rules (PRD 12.1, backend doc 8.34): from when an order's buyer data goes.
 */

/** Orders anonymized per transaction, and how long one job keeps at it before the next scan continues. */
export const ANONYMIZE_BATCH = 500;
export const ANONYMIZE_BUDGET_MS = 20_000;

/**
 * The moment `months` calendar months before `now` (UTC), the day clamped to the shorter month as
 * PostgreSQL's interval arithmetic does: orders placed before it are past their retention.
 */
export function retentionCutoff(now: Date, months: number): Date {
  const target = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() - months,
      1,
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return target;
}
