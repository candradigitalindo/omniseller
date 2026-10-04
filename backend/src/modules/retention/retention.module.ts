import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { FulfillmentModule } from "../fulfillment/fulfillment.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { ListingCopyModule } from "../listing-copy/listing-copy.module";
import { OrdersModule } from "../orders/orders.module";
import { ReturnsModule } from "../returns/returns.module";
import { SyncModule } from "../sync/sync.module";
import { StoreDataDeletionService } from "./store-data-deletion.service";

/**
 * Worker only: deleting data that should not be kept (backend doc 8.23). Now the data of stores
 * disconnected without keeping it; the retention run of 9.5 (old webhooks, buyer anonymization) joins.
 */
@Module({
  imports: [
    ChannelModule,
    OrdersModule,
    FulfillmentModule,
    CatalogModule,
    InventoryModule,
    SyncModule,
    ListingCopyModule,
    ReturnsModule,
  ],
  providers: [StoreDataDeletionService],
  exports: [StoreDataDeletionService],
})
export class RetentionWorkerModule {}
