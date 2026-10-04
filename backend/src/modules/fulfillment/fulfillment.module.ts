import { Module } from "@nestjs/common";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { OrdersModule, OrdersWorkerModule } from "../orders/orders.module";
import { SyncModule } from "../sync/sync.module";
import { DocumentRenderService } from "./document-render.service";
import { DocumentsController, ShipmentsController } from "./fulfillment.controllers";
import { FulfillmentRepository } from "./fulfillment.repository";
import { FulfillmentService } from "./fulfillment.service";
import { FulfillmentWorkerService } from "./fulfillment-worker.service";
import { PickListBuilder } from "./pick-list.builder";

const SERVICES = [FulfillmentRepository, PickListBuilder, FulfillmentService];

/** Fulfillment (api and worker): shipments, documents, pick lists. Files come from the global FilesModule. */
@Module({ imports: [OrdersModule, InventoryModule, ChannelModule], providers: SERVICES, exports: SERVICES })
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
  providers: [FulfillmentWorkerService, DocumentRenderService],
  exports: [FulfillmentWorkerService, DocumentRenderService],
})
export class FulfillmentWorkerModule {}

@Module({ imports: [FulfillmentModule], controllers: [ShipmentsController, DocumentsController] })
export class FulfillmentHttpModule {}
