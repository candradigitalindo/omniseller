import { setTimeout as sleep } from "node:timers/promises";
import { Inject, Injectable } from "@nestjs/common";
import { parseJsonSafe } from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { UnauthorizedError } from "../../common/errors/domain-errors";
import { ENV } from "../../config/config.module";
import type { EnvFor } from "../../config/env.schema";
import type { DbHandle, Tx } from "../../db/client";
import { DB_API, JOB_REGISTRY, QUEUES } from "../../infra/tokens";
import type { QueueRegistry } from "../../jobs/queues";
import type { JobRegistry } from "../../jobs/registry";
import { CONNECTORS, type ConnectorRegistry, type SupportedChannel } from "../channel/connector-registry";

const log = logger.forModule("webhook");

const ENQUEUE_TIMEOUT_MS = 1500;

/** Headers worth keeping for debugging; the signature itself is never stored. */
const KEPT_HEADERS = ["content-type", "user-agent", "x-request-id", "x-tts-request-id"];

export interface ReceiveResult {
  events: number;
  stored: number;
  unknownShop: number;
}

/**
 * The webhook process (technology doc 8.3, invariant I11): verify, store, enqueue, reply. No business
 * logic and no outbound calls. Runs before any tenant is known, so it touches only the global
 * webhook_inbox and the SECURITY DEFINER resolve_store lookup (backend doc 7.5).
 *
 * One inbox row per (notification, shop): a Shopee partner-level push naming several shops becomes
 * several rows, each routed to its tenant. Duplicates (marketplace retries) collapse on
 * UNIQUE (source, event_id). If Redis is down the row stays unprocessed and the scheduler's
 * `webhook.inbox_sweep` enqueues it later; the marketplace still gets its 2xx.
 */
@Injectable()
export class WebhookReceiver {
  constructor(
    @Inject(DB_API) private readonly db: DbHandle,
    @Inject(CONNECTORS) private readonly connectors: ConnectorRegistry,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(JOB_REGISTRY) private readonly registry: JobRegistry,
    @Inject(ENV) private readonly env: EnvFor<"webhook">,
  ) {}

  async receive(
    channel: SupportedChannel,
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
  ): Promise<ReceiveResult> {
    const connector = this.connectors.get(channel);
    const url = `${this.env.PUBLIC_WEBHOOK_URL}/webhooks/${channel}`;
    if (!connector.webhooks.verify({ url, headers, rawBody })) {
      log.warn({ channel, bytes: rawBody.length }, "webhook signature rejected");
      throw new UnauthorizedError("webhook.signature_invalid", "Tanda tangan webhook tidak valid.");
    }
    const events = connector.webhooks.parse(rawBody);
    let payload: unknown;
    try {
      // Integers beyond 2^53 (TikTok Shop product ids) are kept as strings, or they would change on
      // the way into jsonb and back out through JSON.parse.
      payload = parseJsonSafe(rawBody.toString("utf8"));
    } catch {
      payload = { raw: rawBody.toString("utf8").slice(0, 10_000) };
    }
    const kept: Record<string, string> = {};
    for (const h of KEPT_HEADERS) if (headers[h]) kept[h] = headers[h]!;

    const result: ReceiveResult = { events: events.length, stored: 0, unknownShop: 0 };
    for (const event of events) {
      const account = event.externalAccount;
      const shops = account ? [null] : event.externalShopIds.length ? event.externalShopIds : [null];
      for (const shop of shops) {
        const eventId = shops.length > 1 ? `${event.eventId}:${shop}` : event.eventId;
        const inboxId = newId();
        const persist = async (connection: Pick<Tx, "execute">) => {
          const owner = account
            ? await this.resolveAccount(channel, account.kind, account.id, connection)
            : shop
              ? await this.resolveStore(channel, shop, connection)
              : null;
          const inserted = await connection.execute<{ id: string }>(sql`
            INSERT INTO webhook_inbox (id,source,event_id,event_type,external_shop_id,tenant_id,store_id,
                                       external_account_kind,external_account_id,account_id,occurred_at,
                                       signature_valid,headers,payload)
            VALUES (${inboxId},${channel},${eventId},${event.code},${shop},${owner?.tenantId ?? null},
                    ${owner && "storeId" in owner ? owner.storeId : null},
                    ${account?.kind ?? null},${account?.id ?? null},
                    ${owner && "accountId" in owner ? owner.accountId : null},${account ? event.occurredAt : null},
                    true,${JSON.stringify(kept)}::jsonb,${JSON.stringify(payload)}::jsonb)
            ON CONFLICT(source,event_id) DO NOTHING RETURNING id`);
          return { inserted: inserted.rows.length > 0, owner };
        };
        // Serialize the routing+insert boundary with a worker committing authorization for this
        // principal. A cancellation is then either visible to its grant fence or routed to the
        // committed account, including a first authorization that has not created its row yet.
        const stored = account
          ? await this.db.db.transaction(async (tx) => {
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtextextended(${`affiliate-principal:${account.kind}:${account.id}`},0))`,
              );
              return persist(tx);
            })
          : await persist(this.db.db);
        if (!stored.inserted) continue;
        result.stored++;
        if (!stored.owner) {
          result.unknownShop++;
          continue;
        }
        await this.enqueue(inboxId, stored.owner.tenantId);
      }
    }
    return result;
  }

  private async resolveStore(channel: string, externalShopId: string, connection: Pick<Tx, "execute">) {
    const r = await connection.execute<{ tenant_id: string; store_id: string }>(
      sql`SELECT tenant_id, store_id FROM resolve_store(${channel}, ${externalShopId})`,
    );
    const row = r.rows[0];
    return row ? { tenantId: row.tenant_id, storeId: row.store_id } : null;
  }

  private async resolveAccount(channel: string, kind: string, externalId: string, connection: Pick<Tx, "execute">) {
    const result = await connection.execute<{ tenant_id: string; account_id: string }>(
      sql`SELECT tenant_id,account_id FROM resolve_affiliate_account(${channel},${kind},${externalId})`,
    );
    const row = result.rows[0];
    return row ? { tenantId: row.tenant_id, accountId: row.account_id } : null;
  }

  /** Best effort: a failure here is repaired by the inbox sweep, so the marketplace still gets 2xx. */
  private async enqueue(inboxId: string, tenantId: string): Promise<void> {
    const def = this.registry.get("webhook", "webhook.process");
    if (!def) return;
    const payload = { inboxId, tenantId };
    try {
      // The queue connection waits for Redis indefinitely (BullMQ needs that); the reply to the
      // marketplace must not, Shopee gives up after 3 seconds.
      await Promise.race([
        this.queues.get(def.queue).add(def.name, payload, { ...def.options, jobId: def.jobId(payload as never, {}) }),
        sleep(ENQUEUE_TIMEOUT_MS).then(() => {
          throw new Error("enqueue timed out");
        }),
      ]);
    } catch (err) {
      log.warn({ err, inbox_id: inboxId }, "enqueue failed; the inbox sweep will retry");
    }
  }
}
