/**
 * Retention as pure rules: from when an order's buyer data goes (PRD 12.1, backend doc 8.34), how a closed
 * business is deleted (8.36), and how long technical records stay (9.5).
 */

const DAY_MS = 86_400_000;

/** Rows deleted per statement of a closed business's purge, and how long one job keeps at it. */
export const PURGE_BATCH = 1000;
export const PURGE_BUDGET_MS = 45_000;

/** Webhooks are kept for replay and debugging (PRD 9.4), outbox events for a look back after delivery. */
export const WEBHOOK_INBOX_KEEP_DAYS = 30;
export const OUTBOX_KEEP_DAYS = 7;
/** Rows per delete of retention.run, and how long one run keeps at it before the next hour. */
export const RETENTION_RUN_BATCH = 5000;
export const RETENTION_RUN_BUDGET_MS = 20_000;

/** Before these moments a received webhook, and a published outbox event, may go. */
export function retentionLimits(now: Date): { webhooksBefore: Date; eventsBefore: Date } {
  return {
    webhooksBefore: new Date(now.getTime() - WEBHOOK_INBOX_KEEP_DAYS * DAY_MS),
    eventsBefore: new Date(now.getTime() - OUTBOX_KEEP_DAYS * DAY_MS),
  };
}

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
