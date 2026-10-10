import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { AccountClosureController } from "./closure.controller";
import { AccountClosureService } from "./closure.service";

/** Account closure (api and worker, backend doc 8.36); the purge itself is the retention module's. */
@Module({
  imports: [IdentityModule, ChannelModule, BillingModule, NotificationInboxModule],
  providers: [AccountClosureService],
  exports: [AccountClosureService],
})
export class ClosureModule {}

@Module({ imports: [ClosureModule], controllers: [AccountClosureController] })
export class ClosureHttpModule {}
