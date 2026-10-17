import { Inject, Injectable } from "@nestjs/common";
import { parseShopeePush } from "@omniseller/connector-shopee";
import { parseTiktokWebhook } from "@omniseller/connector-tiktokshop";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import type { JobRun } from "../../jobs/define";
import { MarketplaceApplicationsService } from "../channel/marketplace-applications.service";
import { describeSyncError } from "./connector-calls";
import { SyncRepository } from "./sync.repository";
import type { WebhookConsumers } from "./webhook-consumer";

const log = logger.forModule("sync.webhooks");

export type InboxOutcome = "processed" | "ignored" | "not_found";

/**
 * Worker side of the webhook inbox (technology doc 8.3): loads one stored notification, normalizes it
 * with its connector, and hands it to the consumers of its kind. The row is marked processed only after
 * every consumer succeeded; a failure is recorded and rethrown for BullMQ to retry.
 */
@Injectable()
export class WebhookInboxService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(SyncRepository) private readonly repo: SyncRepository,
    @Inject(MarketplaceApplicationsService) private readonly applications: MarketplaceApplicationsService,
  ) {}

  async process(ctx: RequestContext, inboxId: string, consumers: WebhookConsumers, run: JobRun): Promise<InboxOutcome> {
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.inboxRow(tx, inboxId));
    // The inbox is global: a row of another tenant is never touched from this tenant's job.
    if (!row || row.processedAt || row.tenantId !== ctx.tenantId || (!row.storeId && !row.accountId))
      return "not_found";
    try {
      const applicationId = await this.applications.id(ctx, row.source);
      if ((applicationId ?? null) !== (row.applicationId ?? null)) {
        await withTenantTx(this.db, ctx, (tx) =>
          this.repo.markInbox(tx, inboxId, { processed: true, error: "application_changed" }),
        );
        return "ignored";
      }
      // Parsing stored, previously verified bytes needs no app credential or current connection.
      const raw = Buffer.from(JSON.stringify(row.payload));
      const [event] =
        row.source === "shopee" ? parseShopeePush(raw) : row.source === "tiktokshop" ? parseTiktokWebhook(raw) : [];
      let consumed = 0;
      if (event?.kind === "account.authorization_revoked" && row.accountId && event.externalAccount) {
        const list = consumers["account.authorization_revoked"] ?? [];
        for (const consume of list)
          await consume(run, {
            accountId: row.accountId,
            externalAccount: event.externalAccount,
            inboxId,
            kind: event.kind,
            code: event.code,
            data: event.data,
            occurredAt: event.occurredAt,
          });
        consumed = list.length;
      } else if (event && event.kind !== "account.authorization_revoked" && row.storeId) {
        const list = consumers[event.kind] ?? [];
        for (const consume of list)
          await consume(run, {
            storeId: row.storeId,
            inboxId,
            kind: event.kind,
            code: event.code,
            data: event.data,
            occurredAt: event.occurredAt,
          });
        consumed = list.length;
      }
      await withTenantTx(this.db, ctx, (tx) =>
        this.repo.markInbox(tx, inboxId, { processed: true, error: consumed ? null : "no_consumer" }),
      );
      return consumed ? "processed" : "ignored";
    } catch (err) {
      const { code, message } = describeSyncError(err);
      log.warn({ err, inbox_id: inboxId }, "webhook processing failed");
      await withTenantTx(this.db, ctx, (tx) =>
        this.repo.markInbox(tx, inboxId, { processed: false, error: `${code}: ${message}`.slice(0, 1000) }),
      );
      throw err;
    }
  }
}
