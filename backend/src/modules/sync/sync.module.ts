import { Module } from "@nestjs/common";
import { SyncRepository } from "./sync.repository";
import { SyncLogService } from "./sync-log.service";
import { WebhookInboxService } from "./webhook-inbox.service";
import { WebhookReceiver } from "./webhook-receiver.service";
import { WebhooksController } from "./webhooks.controller";

/** Sync log and webhook inbox processing (api and worker). */
@Module({
  providers: [SyncRepository, SyncLogService, WebhookInboxService],
  exports: [SyncRepository, SyncLogService, WebhookInboxService],
})
export class SyncModule {}

/** The webhook process: receive, verify, store, enqueue. */
@Module({ providers: [WebhookReceiver], controllers: [WebhooksController] })
export class WebhookHttpModule {}
