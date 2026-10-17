import { Module } from "@nestjs/common";
import { ChannelModule } from "../channel/channel.module";
import { IdentityModule } from "../identity/identity.module";
import { AffiliateAccountsController, AffiliateAuthorizationsController } from "./accounts.controller";
import { AffiliateAccountsRepository } from "./accounts.repository";
import { AffiliateAccountsService } from "./accounts.service";
import { AffiliateAccountConnectService } from "./accounts-connect.service";
import { AffiliateAccountCredentialsService } from "./accounts-credentials.service";
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
  imports: [AffiliateAccountsModule, ChannelModule, IdentityModule],
  providers: [AffiliateAccountConnectService, AffiliateAccountCredentialsService],
  exports: [AffiliateAccountConnectService, AffiliateAccountCredentialsService],
})
export class AffiliateAccountsWorkerModule {}
