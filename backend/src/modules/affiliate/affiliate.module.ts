import { Module } from "@nestjs/common";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { AffiliateProductsController } from "./affiliate.controller";
import { AffiliateRepository } from "./affiliate.repository";
import { AffiliateService } from "./affiliate.service";
import { AffiliateWorkerService } from "./affiliate-worker.service";
@Module({
  imports: [ChannelModule],
  providers: [AffiliateRepository, AffiliateService],
  exports: [AffiliateRepository, AffiliateService],
})
export class AffiliateModule {}
@Module({ imports: [AffiliateModule], controllers: [AffiliateProductsController] })
export class AffiliateHttpModule {}
@Module({
  imports: [AffiliateModule, ChannelModule, IdentityModule],
  providers: [AffiliateWorkerService],
  exports: [AffiliateWorkerService],
})
export class AffiliateWorkerModule {}
