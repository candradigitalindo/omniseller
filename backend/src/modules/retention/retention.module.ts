import { Module } from "@nestjs/common";
import { BusinessModule } from "../business/business.module";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { FulfillmentModule } from "../fulfillment/fulfillment.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { ListingCopyModule } from "../listing-copy/listing-copy.module";
import { OrdersModule } from "../orders/orders.module";
import { ReturnsModule } from "../returns/returns.module";
import { SyncModule } from "../sync/sync.module";
import { BuyerDataRetentionService } from "./buyer-data-retention.service";
import { StoreDataDeletionService } from "./store-data-deletion.service";
import { TenantPurgeService } from "./tenant-purge.service";

/**
 * Worker only: deleting data that should not be kept: the data of stores disconnected without keeping it
 * (backend doc 8.23), buyers' personal data past the business's retention (8.34), and closed businesses
 * past their purge date (8.36).
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
    IdentityModule,
  ],
  providers: [StoreDataDeletionService, BuyerDataRetentionService, TenantPurgeService],
  exports: [StoreDataDeletionService, BuyerDataRetentionService, TenantPurgeService],
})
export class RetentionWorkerModule {}
