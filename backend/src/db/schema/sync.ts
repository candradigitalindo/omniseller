import type { SyncJobStatus } from "@omniseller/shared";
import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, tstz, ulid } from "../columns";

/** Global: written by the webhook process before the tenant is known. */
export const webhookInbox = pgTable("webhook_inbox", {
  id: ulid("id").primaryKey(),
  source: text("source").notNull(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type"),
  externalShopId: text("external_shop_id"),
  tenantId: ulid("tenant_id"),
  storeId: ulid("store_id"),
  accountId: ulid("account_id"),
  externalAccountKind: text("external_account_kind"),
  externalAccountId: text("external_account_id"),
  occurredAt: tstz("occurred_at"),
  receivedAt: tstz("received_at").notNull().defaultNow(),
  signatureValid: boolean("signature_valid").notNull(),
  headers: jsonb("headers").$type<Record<string, string>>().notNull(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  processedAt: tstz("processed_at"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
});

export const syncJob = pgTable("sync_job", {
  ...baseColumns(),
  storeId: ulid("store_id"),
  kind: text("kind").notNull(),
  direction: text("direction").$type<"pull" | "push">().notNull(),
  status: text("status").$type<SyncJobStatus>().notNull().default("queued"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  requestSummary: jsonb("request_summary").$type<Record<string, unknown>>(),
  responseSummary: jsonb("response_summary").$type<Record<string, unknown>>(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: tstz("started_at"),
  finishedAt: tstz("finished_at"),
  durationMs: integer("duration_ms"),
  queueJobId: text("queue_job_id"),
  traceId: text("trace_id"),
});

/** Written in the same transaction as the business change; relayed to BullMQ by the scheduler. */
export const outboxEvent = pgTable("outbox_event", {
  id: ulid("id").primaryKey(),
  tenantId: ulid("tenant_id").notNull(),
  createdAt: tstz("created_at").notNull().defaultNow(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: ulid("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  queue: text("queue").notNull(),
  jobName: text("job_name").notNull(),
  jobId: text("job_id").notNull(),
  jobOptions: jsonb("job_options").$type<Record<string, unknown>>().notNull().default({}),
  publishedAt: tstz("published_at"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
});
