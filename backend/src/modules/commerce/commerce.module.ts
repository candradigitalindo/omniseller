import { Module } from "@nestjs/common";
import { AffiliateAccountsModule, AffiliateAccountsWorkerModule } from "../affiliate-accounts/accounts.module";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { CommerceController } from "./commerce.controller";
import { CommerceRepository } from "./commerce.repository";
import { CommerceService } from "./commerce.service";
import { CommerceFilesController } from "./commerce-files.controller";
import { CommerceFilesRepository } from "./commerce-files.repository";
import { CommerceFilesService } from "./commerce-files.service";
import { CommerceSpoolCleanupService } from "./commerce-upload";
import { CommerceWorkerService } from "./commerce-worker.service";
@Module({
  imports: [ChannelModule, AffiliateAccountsModule, IdentityModule],
  providers: [
    CommerceRepository,
    CommerceService,
    CommerceFilesService,
    CommerceFilesRepository,
    CommerceSpoolCleanupService,
  ],
  exports: [CommerceRepository, CommerceService, CommerceFilesService],
})
export class CommerceModule {}
@Module({ imports: [CommerceModule], controllers: [CommerceController, CommerceFilesController] })
export class CommerceHttpModule {}
@Module({
  imports: [CommerceModule, IdentityModule, AffiliateAccountsWorkerModule],
  providers: [CommerceWorkerService],
  exports: [CommerceWorkerService],
})
export class CommerceWorkerModule {}
