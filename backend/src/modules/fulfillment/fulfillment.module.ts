import { Module } from "@nestjs/common";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { OrdersModule, OrdersWorkerModule } from "../orders/orders.module";
import { SyncModule } from "../sync/sync.module";
import { AutoPrintService } from "./auto-print.service";
import { DocumentRenderService } from "./document-render.service";
import { DocumentsController, ShipmentsController } from "./fulfillment.controllers";
import { FulfillmentRepository } from "./fulfillment.repository";
import { FulfillmentService } from "./fulfillment.service";
import { FulfillmentWorkerService } from "./fulfillment-worker.service";
import { HandoverRepository } from "./handover.repository";
import { HandoverService } from "./handover.service";
import { LabelTemplateService } from "./label-template.service";
import { PackingService } from "./packing.service";
import { PickListBuilder } from "./pick-list.builder";
import { AgentController, PrintAgentsController, PrintJobsController } from "./print.controllers";
import { PrintRepository } from "./print.repository";
import { PrintService } from "./print.service";
import { PrintAgentsService } from "./print-agents.service";
import { HandoversController, PackingController } from "./scan.controllers";
import { ScanService } from "./scan.service";

const SERVICES = [
  FulfillmentRepository,
  PrintRepository,
  HandoverRepository,
  PickListBuilder,
  PrintService,
  FulfillmentService,
  LabelTemplateService,
  ScanService,
  PackingService,
  HandoverService,
  PrintAgentsService,
];

/**
 * Fulfillment (api and worker): shipments, documents, pick lists, print agents and their jobs, packing
 * by scan, and courier handovers. Files come from the global FilesModule, pushes from the global REALTIME.
 */
@Module({
  imports: [OrdersModule, InventoryModule, ChannelModule, IdentityModule],
  providers: SERVICES,
  exports: SERVICES,
})
export class FulfillmentModule {}

/** Worker only: arranging at the marketplace, labels, rendering documents. */
@Module({
  imports: [
    FulfillmentModule,
    OrdersModule,
    OrdersWorkerModule,
    InventoryModule,
    ChannelModule,
    SyncModule,
    IdentityModule,
  ],
  providers: [FulfillmentWorkerService, DocumentRenderService, AutoPrintService],
  exports: [FulfillmentWorkerService, DocumentRenderService, AutoPrintService],
})
export class FulfillmentWorkerModule {}

@Module({
  imports: [FulfillmentModule],
  controllers: [
    ShipmentsController,
    DocumentsController,
    PrintAgentsController,
    PrintJobsController,
    AgentController,
    PackingController,
    HandoversController,
  ],
})
export class FulfillmentHttpModule {}
