import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { ValidationError } from "../../common/errors/domain-errors";
import { limitReached, planLimitReached } from "../../common/plan-limits";
import { hashToken, newSecretToken } from "../../common/security/tokens";
import { ENV } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { TenantsService } from "../identity/tenants.service";
import {
  AUTHORIZATION_FAILURES,
  type AuthorizationFailure,
  authorizationInvalid,
  authorizationNotFound,
  channelUnsupported,
  reauthorizeChannelMismatch,
  storeNotFound,
} from "./channel.errors";
import { storeAuthorizationReceived } from "./channel.events";
import { ChannelRepository, type StoreAuthorizationRow } from "./channel.repository";
import { CONNECTORS, type ConnectorRegistry, isSupportedChannel } from "./connector-registry";
import { isManualChannel, publicWebUrl, StoresService } from "./stores.service";

/** TikTok Shop codes live 30 minutes and Shopee codes 10; the link itself is kept a little longer. */
export const AUTHORIZATION_TTL_MINUTES = 30;
export interface AuthorizationView {
  row: StoreAuthorizationRow;
  status: StoreAuthorizationRow["status"];
}

/** Where the marketplace sends the seller back: a page of the web app that posts to /callback. */
export function callbackUrl(env: Env, channel: string): string {
  return `${publicWebUrl(env)}/integrasi/callback/${channel}`;
}

/**
 * Connecting a store (PRD 6.1, 7.1; backend doc 8.6):
 *
 * 1. api `start`: an unguessable state is stored as a hash on store_authorization and sent to the
 *    marketplace in the authorization link.
 * 2. api `callback`: the web app posts what the marketplace appended to the redirect (code, state,
 *    Shopee's shop_id or main_account_id). The state must belong to the caller's tenant, be pending,
 *    and not be expired; the code goes to the outbox (the api process makes no outbound calls).
 * 3. worker: StoreConnectService exchanges the code and creates or reconnects the stores.
 */
@Injectable()
export class StoreAuthorizationService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ChannelRepository) private readonly repo: ChannelRepository,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(CONNECTORS) private readonly connectors: ConnectorRegistry,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private withStatus(row: StoreAuthorizationRow): AuthorizationView {
    const expired = row.status === "pending" && row.expiresAt.getTime() <= Date.now();
    return { row, status: expired ? "expired" : row.status };
  }

  async start(
    ctx: RequestContext,
    input: { channel: string; storeId?: string | undefined },
  ): Promise<{ view: AuthorizationView; authorizeUrl: string }> {
    if (!isSupportedChannel(input.channel)) throw channelUnsupported(input.channel);
    const channel = input.channel;
    const state = newSecretToken();
    const id = newId();
    return withTenantTx(this.db, ctx, async (tx) => {
      if (input.storeId) {
        if (!this.stores.inScope(ctx, input.storeId)) throw storeNotFound();
        const store = await this.repo.getStore(tx, input.storeId);
        if (!store) throw storeNotFound();
        if (store.channel !== channel) throw reauthorizeChannelMismatch();
      }
      // Checked after the store so that another tenant's store id answers 404 whatever is configured.
      const connector = this.connectors.get(channel);
      if (!input.storeId) {
        // a new store counts against the plan (backend doc 8.32); reconnecting never does
        const plan = await this.tenants.planIn(tx, ctx);
        const connected = (await this.repo.listStores(tx, null)).filter(
          (s) => !isManualChannel(s.channel) && s.status !== "disconnected",
        ).length;
        if (limitReached(plan.limits, "stores", connected)) {
          throw planLimitReached(plan.name, "stores", plan.limits.stores!);
        }
      }
      await this.repo.insertAuthorization(tx, {
        id,
        tenantId: ctx.tenantId,
        channel,
        storeId: input.storeId ?? null,
        requestedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
        stateHash: hashToken(state),
        status: "pending",
        expiresAt: new Date(Date.now() + AUTHORIZATION_TTL_MINUTES * 60_000),
      });
      const view = this.withStatus((await this.repo.getAuthorization(tx, id))!);
      return {
        view,
        authorizeUrl: connector.auth.authorizeUrl({ state, redirectUri: callbackUrl(this.env, channel) }),
      };
    });
  }

  async get(ctx: RequestContext, id: string): Promise<AuthorizationView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.getAuthorization(tx, id);
      if (!row || (row.storeId && !this.stores.inScope(ctx, row.storeId))) throw authorizationNotFound();
      return this.withStatus(row);
    });
  }

  async callback(
    ctx: RequestContext,
    input: {
      channel: string;
      state: string;
      code?: string | undefined;
      shopId?: string | undefined;
      mainAccountId?: string | undefined;
      error?: string | undefined;
    },
  ): Promise<AuthorizationView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      // RLS limits the lookup to the caller's tenant: another tenant's state is simply not found.
      const row = await this.repo.authorizationByStateHash(tx, hashToken(input.state), true);
      if (!row || row.channel !== input.channel) throw authorizationInvalid();
      if (row.status !== "pending") throw authorizationInvalid();
      const now = new Date();
      // An expired attempt reads as "expired" (withStatus); throwing rolls back, so nothing is written.
      if (row.expiresAt.getTime() <= now.getTime()) throw authorizationInvalid();
      if (input.error || !input.code || input.code === "null") {
        await this.repo.updateAuthorization(tx, row.id, { callbackAt: now });
        await this.fail(tx, row.id, "denied", input.error);
        return this.withStatus((await this.repo.getAuthorization(tx, row.id))!);
      }
      if (row.channel === "shopee" && !input.shopId && !input.mainAccountId) {
        throw new ValidationError([{ path: "shopId", message: "shop_id atau main_account_id dari Shopee wajib ada." }]);
      }
      await this.repo.updateAuthorization(tx, row.id, { status: "exchanging", callbackAt: now });
      await this.outbox.enqueue(
        tx,
        ctx,
        storeAuthorizationReceived,
        {
          authorizationId: row.id,
          code: input.code,
          ...(input.shopId ? { shopId: input.shopId } : {}),
          ...(input.mainAccountId ? { mainAccountId: input.mainAccountId } : {}),
        },
        row.id,
      );
      return this.withStatus((await this.repo.getAuthorization(tx, row.id))!);
    });
  }

  private async fail(tx: Tx, id: string, reason: AuthorizationFailure, detail?: string): Promise<void> {
    await this.repo.updateAuthorization(tx, id, failurePatch(reason, detail));
  }
}

export function failurePatch(reason: AuthorizationFailure, detail?: string) {
  return {
    status: reason === "expired" ? ("expired" as const) : ("failed" as const),
    completedAt: new Date(),
    errorCode: reason,
    errorMessage: detail
      ? `${AUTHORIZATION_FAILURES[reason]} (${detail})`.slice(0, 1000)
      : AUTHORIZATION_FAILURES[reason],
  };
}
