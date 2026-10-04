import { Module } from "@nestjs/common";
import { ChannelModule } from "../channel/channel.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { OrdersModule, OrdersWorkerModule } from "../orders/orders.module";
import { SyncModule } from "../sync/sync.module";
import { ReturnAlertsService } from "./return-alerts.service";
import { ReturnSyncService } from "./return-sync.service";
import { ReturnsController } from "./returns.controllers";
import { ReturnsRepository } from "./returns.repository";
import { ReturnsService } from "./returns.service";

const SERVICES = [ReturnsRepository, ReturnsService];

/** Returns (api and worker, backend doc 8.26): lists, decisions, receipts. Files come from the global FilesModule. */
@Module({ imports: [OrdersModule, InventoryModule, ChannelModule], providers: SERVICES, exports: SERVICES })
export class ReturnsModule {}

/**
 * Worker only: reading requests and sending decisions through the global ChannelWorkerModule's
 * MarketplaceGateway, bringing in orders a request names (OrderSyncService), and notifications.
 */
@Module({
  imports: [ReturnsModule, OrdersModule, OrdersWorkerModule, ChannelModule, SyncModule, NotificationInboxModule],
  providers: [ReturnSyncService, ReturnAlertsService],
  exports: [ReturnSyncService, ReturnAlertsService],
})
export class ReturnsWorkerModule {}

/** Api only: the returns screen (L09). */
@Module({ imports: [ReturnsModule], controllers: [ReturnsController] })
export class ReturnsHttpModule {}
