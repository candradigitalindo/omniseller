import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { OrdersModule } from "../orders/orders.module";
import { ReturnsModule } from "../returns/returns.module";
import { AllocationRulesService } from "./allocation-rules.service";
import { InitialStockService } from "./initial-stock.service";
import { InventoryController, StockRulesController, WarehousesController } from "./inventory.controllers";
import { InventoryModule } from "./inventory-core.module";
import { RestockService } from "./restock.service";
import { StockAlertsService } from "./stock-alerts.service";
import { StockComparisonService } from "./stock-comparison.service";
import { StockCountService } from "./stock-count.service";
import { StockHistoryService } from "./stock-history.service";
import { StockCountsController, StockTransfersController } from "./stock-ops.controllers";
import { StockOpsRepository } from "./stock-ops.repository";
import { StockOverviewService } from "./stock-overview.service";
import { StockPushService } from "./stock-push.service";
import { StockTransferService } from "./stock-transfer.service";
import { StockTriggersService } from "./stock-triggers.service";
import { WarehouseAdminService } from "./warehouse-admin.service";

export { InventoryModule };

const STOCK = [
  StockOverviewService,
  InitialStockService,
  AllocationRulesService,
  StockComparisonService,
  RestockService,
  WarehouseAdminService,
  StockOpsRepository,
  StockCountService,
  StockTransferService,
  StockHistoryService,
];

/**
 * Stock list with push state, initial stock, allocation rules, comparison with the marketplace, stock
 * counts and transfers, the stock card's documents (api and worker; the worker applies approved counts).
 */
@Module({
  imports: [
    InventoryModule,
    CatalogModule,
    ChannelModule,
    OrdersModule,
    ReturnsModule,
    IdentityModule,
    NotificationInboxModule,
  ],
  providers: STOCK,
  exports: STOCK,
})
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
  controllers: [
    WarehousesController,
    InventoryController,
    StockRulesController,
    StockCountsController,
    StockTransfersController,
  ],
})
export class InventoryHttpModule {}
