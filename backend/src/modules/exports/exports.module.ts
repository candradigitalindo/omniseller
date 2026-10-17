import { Module } from "@nestjs/common";
import { AffiliateModule } from "../affiliate/affiliate.module";
import { AffiliateAccountsModule } from "../affiliate-accounts/accounts.module";
import { AutomationModule } from "../automation/automation.module";
import { BillingModule } from "../billing/billing.module";
import { BusinessModule } from "../business/business.module";
import { CampaignModule } from "../campaign/campaign.module";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { FulfillmentModule } from "../fulfillment/fulfillment.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryStockModule } from "../inventory/inventory.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { ListingCopyModule } from "../listing-copy/listing-copy.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { OrdersModule } from "../orders/orders.module";
import { ReturnsModule } from "../returns/returns.module";
import { ExportRenderService } from "./export-render.service";
import { ExportsController } from "./exports.controller";
import { ExportsRepository } from "./exports.repository";
import { ExportsService } from "./exports.service";

/** Requests, status, and downloads of full data exports (api). Files come from the global FilesModule. */
@Module({ imports: [IdentityModule], providers: [ExportsRepository, ExportsService], exports: [ExportsService] })
export class ExportsModule {}

/** Worker only: renders an export from the sheets of every module that owns data (backend doc 8.18). */
@Module({
  imports: [
    AffiliateModule,
    AffiliateAccountsModule,
    IdentityModule,
    ChannelModule,
    InventoryModule,
    InventoryStockModule,
    CatalogModule,
    OrdersModule,
    FulfillmentModule,
    NotificationInboxModule,
    ListingCopyModule,
    ReturnsModule,
    BusinessModule,
    CampaignModule,
    BillingModule,
    AutomationModule,
  ],
  providers: [ExportsRepository, ExportRenderService],
  exports: [ExportRenderService],
})
export class ExportsWorkerModule {}

@Module({ imports: [ExportsModule], controllers: [ExportsController] })
export class ExportsHttpModule {}
