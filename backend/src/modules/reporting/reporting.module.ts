import { Module } from "@nestjs/common";
import { BusinessModule } from "../business/business.module";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { OrdersModule } from "../orders/orders.module";
import { DashboardService } from "./dashboard.service";
import { DigestRepository } from "./digest.repository";
import { DigestService } from "./digest.service";
import { DashboardController, ReportsController } from "./reporting.controller";
import { SalesReportService } from "./sales-report.service";

/** Reports read other modules' data through their services; the module owns only `daily_digest` (backend doc 11). */
@Module({
  imports: [OrdersModule, InventoryModule, CatalogModule, ChannelModule, IdentityModule, BusinessModule],
  providers: [DashboardService, SalesReportService],
  exports: [DashboardService, SalesReportService],
})
export class ReportingModule {}

@Module({ imports: [ReportingModule], controllers: [DashboardController, ReportsController] })
export class ReportingHttpModule {}

/** Worker only: the daily operational email (FR-NTF-02). */
@Module({
  imports: [ReportingModule, OrdersModule, InventoryModule, ChannelModule, IdentityModule, NotificationInboxModule],
  providers: [DigestRepository, DigestService],
  exports: [DigestService],
})
export class ReportingWorkerModule {}
