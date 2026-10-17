import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { SyncModule } from "../sync/sync.module";
import { ListingsController, ProductsController } from "./catalog.controllers";
import { CatalogRepository } from "./catalog.repository";
import { ListingPriceRepository } from "./listing-price.repository";
import { ListingPriceService } from "./listing-price.service";
import { ListingPriceWorkerService } from "./listing-price-worker.service";
import { ListingSyncService } from "./listing-sync.service";
import { ListingsService } from "./listings.service";
import { ProductTransferService } from "./product-transfer.service";
import { ProductsService } from "./products.service";

const SERVICES = [
  CatalogRepository,
  ProductsService,
  ListingsService,
  ProductTransferService,
  ListingPriceRepository,
  ListingPriceService,
];

/** Services shared by api and worker. */
@Module({ imports: [ChannelModule, AuditModule, IdentityModule], providers: SERVICES, exports: SERVICES })
export class CatalogModule {}

/** Worker only: listing pulls, item refreshes, status pushes (uses the global ChannelWorkerModule). */
@Module({
  imports: [CatalogModule, ChannelModule, SyncModule, IdentityModule],
  providers: [ListingSyncService, ListingPriceWorkerService],
  exports: [ListingSyncService, ListingPriceWorkerService],
})
export class CatalogWorkerModule {}

@Module({ imports: [CatalogModule], controllers: [ProductsController, ListingsController] })
export class CatalogHttpModule {}
