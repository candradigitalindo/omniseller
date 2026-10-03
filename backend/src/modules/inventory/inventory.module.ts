import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { AllocationRulesService } from "./allocation-rules.service";
import { InitialStockService } from "./initial-stock.service";
import { InventoryController, StockRulesController, WarehousesController } from "./inventory.controllers";
import { InventoryModule } from "./inventory-core.module";
import { StockOverviewService } from "./stock-overview.service";
import { StockPushService } from "./stock-push.service";
import { StockTriggersService } from "./stock-triggers.service";

export { InventoryModule };

const STOCK = [StockOverviewService, InitialStockService, AllocationRulesService];

/** Stock list with push state, initial stock, allocation rules (api and worker). */
@Module({ imports: [InventoryModule, CatalogModule, ChannelModule], providers: STOCK, exports: STOCK })
export class InventoryStockModule {}

/** The stock pusher and its triggers: worker only, marketplaces are called through MarketplaceGateway. */
@Module({
  imports: [InventoryModule, CatalogModule, ChannelModule],
  providers: [StockPushService, StockTriggersService],
  exports: [StockPushService, StockTriggersService],
})
export class InventoryWorkerModule {}

@Module({
  imports: [InventoryModule, InventoryStockModule],
  controllers: [WarehousesController, InventoryController, StockRulesController],
})
export class InventoryHttpModule {}
