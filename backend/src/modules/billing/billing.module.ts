import { Module } from "@nestjs/common";
import { ENV } from "../../config/config.module";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { BillingController } from "./billing.controller";
import { BillingRepository } from "./billing.repository";
import { BillingService } from "./billing.service";
import { BillingOverviewService } from "./billing-overview.service";
import { BillingWorkerService, XENDIT } from "./billing-worker.service";
import { UsageMeterService } from "./usage-meter.service";
import { XenditClient, type XenditEnv } from "./xendit.client";
import { XenditWebhookController, XenditWebhookService } from "./xendit-webhook.controller";

/**
 * Subscriptions, invoices, and usage (backend doc 8.32): api, worker, reporting (the dashboard task),
 * exports, and orders (the usage meter). Imports only identity and notifications, so the modules that
 * import it never form a cycle.
 */
@Module({
  imports: [IdentityModule, NotificationInboxModule],
  providers: [BillingRepository, BillingService, UsageMeterService],
  exports: [BillingRepository, BillingService, UsageMeterService],
})
export class BillingModule {}

/** HTTP side, api process only: L45 with the counts the owning modules give. */
@Module({
  imports: [BillingModule, IdentityModule, ChannelModule, InventoryModule],
  providers: [BillingOverviewService],
  controllers: [BillingController],
})
export class BillingHttpModule {}

/** Worker only: the Xendit client (the secret key is the worker's) and the invoice creation job. */
@Module({
  imports: [BillingModule, IdentityModule],
  providers: [
    { provide: XENDIT, inject: [ENV], useFactory: (env: XenditEnv) => new XenditClient(env) },
    BillingWorkerService,
  ],
  exports: [BillingWorkerService],
})
export class BillingWorkerModule {}

/** Webhook process only: Xendit's invoice callbacks. */
@Module({ providers: [XenditWebhookService], controllers: [XenditWebhookController] })
export class BillingWebhookModule {}
