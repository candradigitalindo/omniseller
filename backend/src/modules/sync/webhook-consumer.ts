import type { NormalizedWebhookEvent, WebhookEventKind } from "@omniseller/connector-core";
import type { JobRun } from "../../jobs/define";

/** A normalized marketplace notification about one connected store, as handed to consumers. */
export interface StoreWebhookEvent extends Pick<NormalizedWebhookEvent, "kind" | "code" | "data" | "occurredAt"> {
  kind: Exclude<WebhookEventKind, "account.authorization_revoked">;
  storeId: string;
  inboxId: string;
}

export interface AccountWebhookEvent extends Pick<NormalizedWebhookEvent, "kind" | "code" | "data" | "occurredAt"> {
  kind: "account.authorization_revoked";
  accountId: string;
  inboxId: string;
  externalAccount: NonNullable<NormalizedWebhookEvent["externalAccount"]>;
}
export type WebhookConsumer = (run: JobRun, event: StoreWebhookEvent) => Promise<unknown>;

/**
 * Consumers per event kind. Modules export their table (channel: authorization events; orders later:
 * order events) and `jobs/webhook-consumers.ts` merges them, the same way jobs/registry.ts collects jobs.
 */
export type WebhookConsumers = {
  [K in WebhookEventKind]?: ((
    run: JobRun,
    event: K extends "account.authorization_revoked" ? AccountWebhookEvent : StoreWebhookEvent,
  ) => Promise<unknown>)[];
};

export function mergeConsumers(...tables: WebhookConsumers[]): WebhookConsumers {
  const out: WebhookConsumers = {};
  for (const table of tables) {
    for (const [kind, list] of Object.entries(table)) {
      const combined = out as Record<string, unknown[]>;
      combined[kind] = [...(combined[kind] ?? []), ...list];
    }
  }
  return out;
}
