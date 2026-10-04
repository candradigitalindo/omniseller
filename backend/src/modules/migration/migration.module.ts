import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ChannelModule } from "../channel/channel.module";
import { InventoryStockModule } from "../inventory/inventory.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { OrdersModule } from "../orders/orders.module";
import { CutoverService } from "./cutover.service";
import { ImportRunnerService } from "./import-runner.service";
import { ImportsService } from "./imports.service";
import { MigrationCutoverController, MigrationImportsController } from "./migration.controllers";
import { MigrationRepository } from "./migration.repository";
import { ParallelModeService } from "./parallel-mode.service";

const SERVICES = [MigrationRepository, ImportsService, ParallelModeService, CutoverService];

/** Moving from another app (api and worker): imports, parallel mode, cutover. Files come from the global FilesModule. */
@Module({
  imports: [CatalogModule, ChannelModule, OrdersModule, InventoryStockModule],
  providers: SERVICES,
  exports: SERVICES,
})
export class MigrationModule {}

/** Worker only: validating and importing files. */
@Module({
  imports: [MigrationModule, CatalogModule, InventoryModule, NotificationInboxModule],
  providers: [ImportRunnerService],
  exports: [ImportRunnerService],
})
export class MigrationWorkerModule {}

@Module({ imports: [MigrationModule], controllers: [MigrationImportsController, MigrationCutoverController] })
export class MigrationHttpModule {}
