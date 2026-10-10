import { Module } from "@nestjs/common";
import { CampaignModule } from "../campaign/campaign.module";
import { ChannelModule } from "../channel/channel.module";
import { FulfillmentModule } from "../fulfillment/fulfillment.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { OrdersModule } from "../orders/orders.module";
import { AutoProcessService } from "./auto-process.service";
import { OrderRulesController } from "./automation.controller";
import { OrderRulesRepository } from "./automation.repository";
import { OrderRulesService } from "./order-rules.service";

const SERVICES = [OrderRulesRepository, OrderRulesService, AutoProcessService];

/**
 * Automatic order processing (api and worker, backend doc 8.37): the rules, and the engine the worker
 * runs for new orders. Acts on orders only through the orders and fulfillment services.
 */
@Module({
  imports: [OrdersModule, FulfillmentModule, IdentityModule, CampaignModule, ChannelModule, InventoryModule],
  providers: SERVICES,
  exports: SERVICES,
})
export class AutomationModule {}

@Module({ imports: [AutomationModule], controllers: [OrderRulesController] })
export class AutomationHttpModule {}
