import { Module } from "@nestjs/common";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { SyncModule } from "../sync/sync.module";
import { AffiliateAccountsController, AffiliateAuthorizationsController } from "./accounts.controller";
import { AffiliateAccountsRepository } from "./accounts.repository";
import { AffiliateAccountsService } from "./accounts.service";
import { AffiliateAccountConnectService } from "./accounts-connect.service";
import { AffiliateAccountCredentialsService } from "./accounts-credentials.service";
import { AffiliateAccountRevocationService } from "./accounts-revocation.service";
@Module({
  imports: [ChannelModule],
  providers: [AffiliateAccountsRepository, AffiliateAccountsService],
  exports: [AffiliateAccountsRepository, AffiliateAccountsService],
})
export class AffiliateAccountsModule {}
@Module({
  imports: [AffiliateAccountsModule],
  controllers: [AffiliateAccountsController, AffiliateAuthorizationsController],
})
export class AffiliateAccountsHttpModule {}
@Module({
  imports: [AffiliateAccountsModule, ChannelModule, IdentityModule, SyncModule],
  providers: [AffiliateAccountConnectService, AffiliateAccountCredentialsService, AffiliateAccountRevocationService],
  exports: [AffiliateAccountConnectService, AffiliateAccountCredentialsService, AffiliateAccountRevocationService],
})
export class AffiliateAccountsWorkerModule {}
