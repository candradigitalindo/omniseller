import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
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
import { ReportAttachments } from "./report-attachments";
import { DashboardController, ReportsController } from "./reporting.controller";
import { SalesReportService } from "./sales-report.service";
import { ScheduledReportRepository } from "./scheduled-report.repository";
import { ScheduledReportService } from "./scheduled-report.service";
import { StaffReportService } from "./staff-report.service";

/** Reports read other modules' data through their services; the module owns `daily_digest` and `report_schedule_run` (backend doc 11). */
@Module({
  imports: [OrdersModule, InventoryModule, CatalogModule, ChannelModule, IdentityModule, BusinessModule, BillingModule],
  providers: [DashboardService, SalesReportService, StaffReportService],
  exports: [DashboardService, SalesReportService, StaffReportService],
})
export class ReportingModule {}

@Module({ imports: [ReportingModule], controllers: [DashboardController, ReportsController] })
export class ReportingHttpModule {}

/** Worker only: the daily operational email (FR-NTF-02) and the scheduled report emails (FR-RPT-05). */
@Module({
  imports: [ReportingModule, OrdersModule, InventoryModule, ChannelModule, IdentityModule, NotificationInboxModule],
  providers: [DigestRepository, DigestService, ScheduledReportRepository, ScheduledReportService, ReportAttachments],
  exports: [DigestService, ScheduledReportService],
})
export class ReportingWorkerModule {}
