import { Module } from "@nestjs/common";
import { CatalogModule, CatalogWorkerModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { SyncModule } from "../sync/sync.module";
import { ManualOrdersService } from "./manual-orders.service";
import { OrderAlertsService } from "./order-alerts.service";
import { OrderIntakeService } from "./order-intake.service";
import { OrderSyncService } from "./order-sync.service";
import { OrdersController, TagsController } from "./orders.controllers";
import { OrdersRepository } from "./orders.repository";
import { OrdersService } from "./orders.service";
import { TagsRepository } from "./tags.repository";
import { TagsService } from "./tags.service";

const SERVICES = [OrdersRepository, TagsRepository, OrderIntakeService, OrdersService];

/** Orders (api and worker): the queue, one order, seller actions, and marketplace intake. */
@Module({
  imports: [InventoryModule, CatalogModule, ChannelModule, IdentityModule],
  providers: SERVICES,
  exports: SERVICES,
})
export class OrdersModule {}

/** Worker only: reading orders from marketplaces and cancelling there (MarketplaceGateway), ship-by alerts. */
@Module({
  imports: [OrdersModule, ChannelModule, CatalogModule, CatalogWorkerModule, SyncModule, NotificationInboxModule],
  providers: [OrderSyncService, OrderAlertsService],
  exports: [OrderSyncService, OrderAlertsService],
})
export class OrdersWorkerModule {}

/** Api only: manual orders (FR-ORD-09) and tags (FR-ORD-04). */
@Module({
  imports: [OrdersModule, ChannelModule, InventoryModule, IdentityModule],
  providers: [ManualOrdersService, TagsService],
  controllers: [OrdersController, TagsController],
})
export class OrdersHttpModule {}
