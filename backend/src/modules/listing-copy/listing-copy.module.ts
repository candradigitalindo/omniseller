import { Module } from "@nestjs/common";
import { ENV } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import { CatalogModule, CatalogWorkerModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { InventoryStockModule } from "../inventory/inventory.module";
import { CategoriesService } from "./categories.service";
import { CategorySyncService } from "./category-sync.service";
import { CopyWorkerService } from "./copy-worker.service";
import {
  ListingCopiesController,
  ListingDraftsController,
  StoreCategoriesController,
} from "./listing-copy.controllers";
import { ListingCopyRepository } from "./listing-copy.repository";
import { ListingCopyService } from "./listing-copy.service";
import { IMAGE_FETCH, imageFetchConfig } from "./listing-copy.tokens";

const SERVICES = [ListingCopyRepository, CategoriesService, ListingCopyService];

/** Copies, drafts, and the category cache: api and worker (backend doc 8.25). */
@Module({ imports: [CatalogModule, ChannelModule], providers: SERVICES, exports: SERVICES })
export class ListingCopyModule {}

/**
 * Worker only: preparing drafts, reading categories, and publishing, through the global
 * ChannelWorkerModule's MarketplaceGateway.
 */
@Module({
  imports: [ListingCopyModule, CatalogModule, CatalogWorkerModule, ChannelModule, InventoryStockModule],
  providers: [
    CategorySyncService,
    CopyWorkerService,
    { provide: IMAGE_FETCH, inject: [ENV], useFactory: (env: Env) => imageFetchConfig(env) },
  ],
  exports: [CategorySyncService, CopyWorkerService],
})
export class ListingCopyWorkerModule {}

@Module({
  imports: [ListingCopyModule, ChannelModule],
  controllers: [StoreCategoriesController, ListingCopiesController, ListingDraftsController],
})
export class ListingCopyHttpModule {}
