import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { OrdersModule } from "../orders/orders.module";
import { AllocationRulesService } from "./allocation-rules.service";
import { InitialStockService } from "./initial-stock.service";
import { InventoryController, StockRulesController, WarehousesController } from "./inventory.controllers";
import { InventoryModule } from "./inventory-core.module";
import { RestockService } from "./restock.service";
import { StockAlertsService } from "./stock-alerts.service";
import { StockComparisonService } from "./stock-comparison.service";
import { StockOverviewService } from "./stock-overview.service";
import { StockPushService } from "./stock-push.service";
import { StockTriggersService } from "./stock-triggers.service";

export { InventoryModule };

const STOCK = [
  StockOverviewService,
  InitialStockService,
  AllocationRulesService,
  StockComparisonService,
  RestockService,
];

/** Stock list with push state, initial stock, allocation rules, comparison with the marketplace (api and worker). */
@Module({ imports: [InventoryModule, CatalogModule, ChannelModule, OrdersModule], providers: STOCK, exports: STOCK })
export class InventoryStockModule {}

/** The stock pusher and its triggers: worker only, marketplaces are called through MarketplaceGateway. */
@Module({
  imports: [InventoryModule, CatalogModule, ChannelModule, NotificationInboxModule],
  providers: [StockPushService, StockTriggersService, StockAlertsService],
  exports: [StockPushService, StockTriggersService, StockAlertsService],
})
export class InventoryWorkerModule {}

@Module({
  imports: [InventoryModule, InventoryStockModule],
  controllers: [WarehousesController, InventoryController, StockRulesController],
})
export class InventoryHttpModule {}
