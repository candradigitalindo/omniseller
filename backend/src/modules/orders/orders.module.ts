import { Module } from "@nestjs/common";
import { CatalogModule, CatalogWorkerModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { SyncModule } from "../sync/sync.module";
import { OrderAlertsService } from "./order-alerts.service";
import { OrderIntakeService } from "./order-intake.service";
import { OrderSyncService } from "./order-sync.service";
import { OrdersController } from "./orders.controllers";
import { OrdersRepository } from "./orders.repository";
import { OrdersService } from "./orders.service";

const SERVICES = [OrdersRepository, OrderIntakeService, OrdersService];

/** Orders (api and worker): the queue, one order, seller actions, and marketplace intake. */
@Module({ imports: [InventoryModule, CatalogModule, ChannelModule], providers: SERVICES, exports: SERVICES })
export class OrdersModule {}

/** Worker only: reading orders from marketplaces and cancelling there (MarketplaceGateway), ship-by alerts. */
@Module({
  imports: [
    OrdersModule,
    ChannelModule,
    CatalogModule,
    CatalogWorkerModule,
    SyncModule,
    IdentityModule,
    NotificationInboxModule,
  ],
  providers: [OrderSyncService, OrderAlertsService],
  exports: [OrderSyncService, OrderAlertsService],
})
export class OrdersWorkerModule {}

@Module({ imports: [OrdersModule], controllers: [OrdersController] })
export class OrdersHttpModule {}
