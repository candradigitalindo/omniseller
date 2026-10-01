import { Module } from "@nestjs/common";
import { ChannelModule } from "../channel/channel.module";
import { SyncModule } from "../sync/sync.module";
import { ListingsController, ProductsController } from "./catalog.controllers";
import { CatalogRepository } from "./catalog.repository";
import { ListingSyncService } from "./listing-sync.service";
import { ListingsService } from "./listings.service";
import { ProductTransferService } from "./product-transfer.service";
import { ProductsService } from "./products.service";

const SERVICES = [CatalogRepository, ProductsService, ListingsService, ProductTransferService];

/** Services shared by api and worker. */
@Module({ imports: [ChannelModule], providers: SERVICES, exports: SERVICES })
export class CatalogModule {}

/** Worker only: listing pulls, item refreshes, status pushes (uses the global ChannelWorkerModule). */
@Module({
  imports: [CatalogModule, ChannelModule, SyncModule],
  providers: [ListingSyncService],
  exports: [ListingSyncService],
})
export class CatalogWorkerModule {}

@Module({ imports: [CatalogModule], controllers: [ProductsController, ListingsController] })
export class CatalogHttpModule {}
