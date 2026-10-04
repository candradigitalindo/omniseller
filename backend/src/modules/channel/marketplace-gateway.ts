import { Inject, Injectable } from "@nestjs/common";
import { isConnectorError, type MarketplaceConnector, type ShopCredentials } from "@omniseller/connector-core";
import type { RequestContext } from "../../common/context/request-context";
import type { RateLimiter } from "../../common/security/rate-limiter";
import { RATE_LIMITER } from "../../infra/tokens";
import { withRequestGate } from "../sync/connector-calls";
import { type SyncLogEntry, SyncLogService } from "../sync/sync-log.service";
import type { StoreRow } from "./channel.repository";
import { CONNECTORS, type ConnectorRegistry } from "./connector-registry";
import { CredentialService, revokedReason } from "./credential.service";
import { StoresService } from "./stores.service";

export type ShopCall<T> = (connector: MarketplaceConnector, shop: ShopCredentials, store: StoreRow) => Promise<T>;

export interface CallOptions {
  /**
   * Work nobody waits for, such as parcel tracking: it takes at most a share of the store's request
   * rate (`BACKGROUND_SHARE`) and may wait longer for it, so stock pushes and order work keep theirs.
   */
  background?: boolean;
}

/**
 * The one way the worker calls a marketplace for a store (backend doc 8.6, `ConnectorRegistry.forStore`):
 *
 * - takes a token from the store's bucket (manifest rate, Redis) before every HTTP request; background
 *   work also from its smaller share
 * - records the call in the store's sync log with every HTTP request it made
 * - refreshes and retries once when the marketplace says the access token expired
 * - moves the store to `reauth_required` when the marketplace says the authorization is gone
 */
@Injectable()
export class MarketplaceGateway {
  constructor(
    @Inject(CONNECTORS) private readonly connectors: ConnectorRegistry,
    @Inject(CredentialService) private readonly credentials: CredentialService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(SyncLogService) private readonly syncLog: SyncLogService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  async call<T>(
    ctx: RequestContext,
    storeId: string,
    entry: Omit<SyncLogEntry, "storeId">,
    fn: ShopCall<T>,
    summarize?: (result: T) => Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<T> {
    return this.syncLog.run(
      ctx,
      { ...entry, storeId },
      async () => {
        let { store, shop } = await this.credentials.forShop(ctx, storeId);
        const connector = this.connectors.get(store.channel);
        const gate = {
          limiter: this.limiter,
          key: `mp:${connector.manifest.id}:${storeId}`,
          rule: connector.manifest.shopRateLimit,
          background: options.background === true,
        };
        return withRequestGate(gate, async () => {
          try {
            return await fn(connector, shop, store);
          } catch (err) {
            if (isConnectorError(err) && err.kind === "auth_expired") {
              await this.credentials.refresh(ctx, storeId, { force: true });
              ({ store, shop } = await this.credentials.forShop(ctx, storeId));
              return await this.revokedGuard(ctx, storeId, () => fn(connector, shop, store));
            }
            if (isConnectorError(err) && err.kind === "auth_revoked") {
              await this.stores.markReauthRequired(ctx, storeId, revokedReason(err.code));
            }
            throw err;
          }
        });
      },
      summarize,
    );
  }

  private async revokedGuard<T>(ctx: RequestContext, storeId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // Still rejected with a fresh token: the authorization itself is no longer valid.
      if (isConnectorError(err) && (err.kind === "auth_revoked" || err.kind === "auth_expired")) {
        await this.stores.markReauthRequired(ctx, storeId, revokedReason(err.code));
      }
      throw err;
    }
  }
}
