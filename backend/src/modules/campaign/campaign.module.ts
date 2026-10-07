import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { InventoryModule } from "../inventory/inventory-core.module";
import { CourierCutoffsController, CourierHolidaysController, OperatingHoursController } from "./campaign.controller";
import { CampaignRepository } from "./campaign.repository";
import { CourierCalendarService } from "./courier-calendar.service";

/**
 * Courier cut-offs, courier holidays, and operating hours (backend doc 8.31): api, worker (the orders
 * module computes internal deadlines from them), and exports. Campaigns themselves come later.
 */
@Module({
  imports: [IdentityModule, InventoryModule],
  providers: [CampaignRepository, CourierCalendarService],
  exports: [CourierCalendarService],
})
export class CampaignModule {}

/** HTTP side, api process only. */
@Module({
  imports: [CampaignModule],
  controllers: [CourierCutoffsController, CourierHolidaysController, OperatingHoursController],
})
export class CampaignHttpModule {}
