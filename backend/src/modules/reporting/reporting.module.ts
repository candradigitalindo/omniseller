import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { OrdersModule } from "../orders/orders.module";
import { DashboardService } from "./dashboard.service";
import { DashboardController } from "./reporting.controller";

/** Reports read other modules' data through their services; this module owns no tables (backend doc 11). */
@Module({
  imports: [OrdersModule, InventoryModule, CatalogModule, ChannelModule, IdentityModule],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class ReportingModule {}

@Module({ imports: [ReportingModule], controllers: [DashboardController] })
export class ReportingHttpModule {}
