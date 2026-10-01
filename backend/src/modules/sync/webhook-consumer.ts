import type { NormalizedWebhookEvent, WebhookEventKind } from "@omniseller/connector-core";
import type { JobRun } from "../../jobs/define";

/** A normalized marketplace notification about one connected store, as handed to consumers. */
export interface StoreWebhookEvent extends Pick<NormalizedWebhookEvent, "kind" | "code" | "data" | "occurredAt"> {
  storeId: string;
  inboxId: string;
}

export type WebhookConsumer = (run: JobRun, event: StoreWebhookEvent) => Promise<unknown>;

/**
 * Consumers per event kind. Modules export their table (channel: authorization events; orders later:
 * order events) and `jobs/webhook-consumers.ts` merges them, the same way jobs/registry.ts collects jobs.
 */
export type WebhookConsumers = Partial<Record<WebhookEventKind, WebhookConsumer[]>>;

export function mergeConsumers(...tables: WebhookConsumers[]): WebhookConsumers {
  const out: WebhookConsumers = {};
  for (const table of tables) {
    for (const [kind, list] of Object.entries(table) as [WebhookEventKind, WebhookConsumer[]][]) {
      out[kind] = [...(out[kind] ?? []), ...list];
    }
  }
  return out;
}
