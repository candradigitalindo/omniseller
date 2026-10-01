import { type DynamicModule, Global, Module } from "@nestjs/common";
import { AwsKmsKeyProvider, type KeyProvider, LocalKeyProvider } from "../../common/security/key-provider";
import { TokenVault } from "../../common/security/token-vault";
import type { Env, EnvFor } from "../../config/env.schema";
import { TOKEN_VAULT } from "../../infra/tokens";
import { InventoryModule } from "../inventory/inventory.module";
import { SyncModule } from "../sync/sync.module";
import { ChannelsController, StoreAuthorizationsController, StoresController } from "./channel.controllers";
import { ChannelRepository } from "./channel.repository";
import { ChannelSyncService } from "./channel-sync.service";
import { CONNECTORS, ConnectorRegistry } from "./connector-registry";
import { CredentialService } from "./credential.service";
import { MarketplaceGateway } from "./marketplace-gateway";
import { StoreAuthorizationService } from "./store-authorization.service";
import { StoreConnectService } from "./store-connect.service";
import { StoresService } from "./stores.service";

/**
 * Marketplace connectors of this process, built from its environment (api: link builders only,
 * webhook: signature checks, worker: API clients). Global so the sync module can parse webhooks.
 */
@Global()
@Module({})
export class ConnectorsModule {
  static forEnv(env: Env, fetchImpl?: typeof fetch): DynamicModule {
    return {
      module: ConnectorsModule,
      providers: [{ provide: CONNECTORS, useValue: ConnectorRegistry.fromEnv(env, fetchImpl) }],
      exports: [CONNECTORS],
    };
  }
}

/** Services shared by api and worker: stores, connection attempts. */
@Module({
  imports: [SyncModule, InventoryModule],
  providers: [ChannelRepository, StoresService, StoreAuthorizationService],
  exports: [ChannelRepository, StoresService, StoreAuthorizationService],
})
export class ChannelModule {}

export function keyProviderFor(env: EnvFor<"worker">): KeyProvider {
  if (env.TOKEN_KEY_PROVIDER === "local") return new LocalKeyProvider(env.TOKEN_LOCAL_MASTER_KEY!);
  return AwsKmsKeyProvider.create(env.KMS_KEY_ID_TOKENS!, env.AWS_REGION!);
}

/** Worker only: tokens, marketplace calls, the code exchange, warehouse and webhook sync. */
@Module({})
export class ChannelWorkerModule {
  static forEnv(env: EnvFor<"worker">): DynamicModule {
    const services = [CredentialService, MarketplaceGateway, StoreConnectService, ChannelSyncService];
    return {
      module: ChannelWorkerModule,
      imports: [ChannelModule, SyncModule, InventoryModule],
      providers: [{ provide: TOKEN_VAULT, useValue: new TokenVault(keyProviderFor(env)) }, ...services],
      exports: [TOKEN_VAULT, ...services],
    };
  }
}

@Module({
  imports: [ChannelModule, SyncModule],
  controllers: [ChannelsController, StoreAuthorizationsController, StoresController],
})
export class ChannelHttpModule {}
