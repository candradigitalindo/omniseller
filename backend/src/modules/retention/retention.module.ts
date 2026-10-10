import { Module } from "@nestjs/common";
import { BusinessModule } from "../business/business.module";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { FulfillmentModule } from "../fulfillment/fulfillment.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { ListingCopyModule } from "../listing-copy/listing-copy.module";
import { OrdersModule } from "../orders/orders.module";
import { ReturnsModule } from "../returns/returns.module";
import { SyncModule } from "../sync/sync.module";
import { BuyerDataRetentionService } from "./buyer-data-retention.service";
import { StoreDataDeletionService } from "./store-data-deletion.service";

/**
 * Worker only: deleting data that should not be kept: the data of stores disconnected without keeping it
 * (backend doc 8.23), and buyers' personal data past the business's retention (8.34).
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
    BusinessModule,
  ],
  providers: [StoreDataDeletionService, BuyerDataRetentionService],
  exports: [StoreDataDeletionService, BuyerDataRetentionService],
})
export class RetentionWorkerModule {}
