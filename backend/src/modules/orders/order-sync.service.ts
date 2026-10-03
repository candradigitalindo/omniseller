import { Inject, Injectable } from "@nestjs/common";
import type { NormalizedOrder } from "@omniseller/connector-core";
import { isConnectorError } from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { ListingSyncService } from "../catalog/listing-sync.service";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { StoresService } from "../channel/stores.service";
import { describeSyncError } from "../sync/connector-calls";
import { SyncLogService } from "../sync/sync-log.service";
import { OrderIntakeService } from "./order-intake.service";
import { orderPullRequested } from "./orders.events";
import { OrdersRepository } from "./orders.repository";

const log = logger.forModule("orders.sync");

/** Pages per job; a long history continues in a new job, so a restart only repeats one batch. */
export const ORDER_PAGES_PER_JOB = 5;
/** The first pull reads this far back (FR-INT-04, FR-MIG-04). */
export const INITIAL_DAYS = 90;
/** Incremental pulls look back a little before the last pull started, to cover clock skew. */
const OVERLAP_MS = 10 * 60_000;
const USABLE = new Set(["active", "token_expiring"]);

export interface OrderPullInput {
  storeId: string;
  mode: "initial" | "incremental";
  cursor?: string | undefined;
  startedAt?: string | undefined;
  from?: string | undefined;
}

export interface IngestOutcome {
  created: number;
  updated: number;
  stale: number;
}

/**
 * Worker side of orders (PRD FR-ORD-01, FR-INT-04, 05, FR-ORD-13): reads orders from the marketplace
 * through MarketplaceGateway and hands each to OrderIntakeService in its own short transaction.
 * Webhooks refresh single orders; the scheduler polls every 5 minutes; a new store imports 90 days.
 */
@Injectable()
export class OrderSyncService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersRepository) private readonly repo: OrdersRepository,
    @Inject(OrderIntakeService) private readonly intake: OrderIntakeService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
    @Inject(ListingSyncService) private readonly listingSync: ListingSyncService,
    @Inject(SyncLogService) private readonly syncLog: SyncLogService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  private async usable(ctx: RequestContext, storeId: string): Promise<boolean> {
    try {
      return USABLE.has((await this.stores.get(ctx, storeId)).store.status);
    } catch {
      return false;
    }
  }

  /** Applies orders one transaction each; a race on a new order is retried once as an update. */
  async ingest(
    ctx: RequestContext,
    storeId: string,
    orders: NormalizedOrder[],
    meta: { source: "webhook" | "poll"; rawRef?: string | null },
  ): Promise<IngestOutcome> {
    const outcome: IngestOutcome = { created: 0, updated: 0, stale: 0 };
    const unknownItems = new Set<string>();
    for (const snap of orders) {
      const apply = () =>
        withTenantTx(this.db, ctx, async (tx) => {
          const target = (await this.stores.stockTargetsIn(tx, [storeId])).get(storeId);
          if (!target) return null;
          return this.intake.applyIn(tx, ctx, target, snap, meta);
        });
      let result: Awaited<ReturnType<typeof apply>>;
      try {
        result = await apply();
      } catch (err) {
        const code =
          (err as { code?: string; cause?: { code?: string } }).code ??
          (err as { cause?: { code?: string } }).cause?.code;
        if (code !== "23505") throw err;
        result = await apply();
      }
      if (!result) continue;
      outcome[result.outcome]++;
      for (const id of result.unknownItemIds) unknownItems.add(id);
    }
    // items the shop added since the last listing pull: read them now so their SKUs can map
    if (unknownItems.size > 0) await this.listingSync.refreshItems(ctx, storeId, [...unknownItems]);
    return outcome;
  }

  /** Re-reads specific orders (webhook, after a seller action). */
  async refresh(
    ctx: RequestContext,
    storeId: string,
    externalOrderIds: string[],
    meta: { source: "webhook" | "poll"; rawRef?: string | null; queueJobId?: string },
  ): Promise<IngestOutcome | null> {
    const ids = [...new Set(externalOrderIds)].filter(Boolean);
    if (ids.length === 0 || !(await this.usable(ctx, storeId))) return null;
    const orders = await this.gateway.call(
      ctx,
      storeId,
      {
        kind: "orders.refresh",
        direction: "pull",
        request: { orders: ids.length },
        ...(meta.queueJobId ? { queueJobId: meta.queueJobId } : {}),
      },
      (connector, shop) => connector.orders.getOrders(shop, ids),
      (r) => ({ orders: r.length }),
    );
    return this.ingest(ctx, storeId, orders, { source: meta.source, rawRef: meta.rawRef ?? null });
  }

  /**
   * The first pull reads orders created in the last 90 days; later pulls read orders updated since the
   * last pull. Up to ORDER_PAGES_PER_JOB pages run in one job; the rest continues through
   * `order.pull_requested`. Orders already shipped when first seen never touch stock (doc 7.9).
   */
  async pull(
    ctx: RequestContext,
    input: OrderPullInput,
    queueJobId?: string,
  ): Promise<(IngestOutcome & { done: boolean }) | null> {
    if (!(await this.usable(ctx, input.storeId))) {
      await this.syncLog.skipped(
        ctx,
        { storeId: input.storeId, kind: "orders.pull", direction: "pull" },
        "Toko tidak terhubung.",
      );
      return null;
    }
    const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
    let mode = input.mode;
    let from = input.from ? new Date(input.from) : null;
    if (mode === "incremental" && !from) {
      const last = await this.stores.syncCursor(ctx, input.storeId, "orders");
      if (last) from = new Date(new Date(last).getTime() - OVERLAP_MS);
      else mode = "initial";
    }
    if (mode === "initial" && !from) from = new Date(startedAt.getTime() - INITIAL_DAYS * 86_400_000);
    const by = mode === "initial" ? ("create_time" as const) : ("update_time" as const);

    let cursor: string | null = input.cursor ?? null;
    let pages = 0;
    const total: IngestOutcome = { created: 0, updated: 0, stale: 0 };
    while (pages < ORDER_PAGES_PER_JOB) {
      const page = await this.gateway.call(
        ctx,
        input.storeId,
        {
          kind: "orders.pull",
          direction: "pull",
          request: { mode, from: from!.toISOString(), cursor: cursor ? "…" : null },
          ...(queueJobId ? { queueJobId } : {}),
        },
        (connector, shop) => connector.orders.listOrders(shop, { by, from: from!, to: startedAt, cursor }),
        (p) => ({ orders: p.orders.length, more: p.nextCursor !== null }),
      );
      const got = await this.ingest(ctx, input.storeId, page.orders, { source: "poll" });
      total.created += got.created;
      total.updated += got.updated;
      total.stale += got.stale;
      pages++;
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    if (cursor) {
      await withTenantTx(this.db, ctx, (tx) =>
        this.outbox.enqueue(
          tx,
          ctx,
          orderPullRequested,
          {
            storeId: input.storeId,
            mode,
            cursor,
            startedAt: startedAt.toISOString(),
            from: from!.toISOString(),
          },
          input.storeId,
        ),
      );
      return { ...total, done: false };
    }
    await this.stores.recordPull(ctx, input.storeId, "orders", startedAt.toISOString());
    log.info({ store_id: input.storeId, mode, ...total }, "order pull finished");
    return { ...total, done: true };
  }

  /** A listing got a variant: open lines that sold it are attached and reserved. */
  async attachListing(ctx: RequestContext, listingId: string): Promise<number> {
    return (await withTenantTx(this.db, ctx, (tx) => this.intake.attachListingIn(tx, ctx, listingId))).length;
  }

  /** Stock of these pairs changed: orders short of them are looked at again. */
  async recheckStock(ctx: RequestContext, pairs: { variantId: string; warehouseId: string }[]): Promise<number> {
    return withTenantTx(this.db, ctx, (tx) => this.intake.recheckStockIn(tx, ctx, pairs));
  }

  /**
   * Seller cancellation at the marketplace (FR-ORD-13), then a fresh read so the cancellation and the
   * released stock come from the marketplace's answer. A refusal is recorded on the order.
   */
  async cancel(ctx: RequestContext, orderId: string, reason: string, queueJobId?: string): Promise<boolean> {
    const loaded = await withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.repo.get(tx, orderId);
      return o ? { o, items: await this.repo.items(tx, [orderId]) } : null;
    });
    if (!loaded || loaded.o.status === "cancelled") return false;
    const { o, items } = loaded;
    try {
      await this.gateway.call(
        ctx,
        o.storeId,
        {
          kind: "orders.cancel",
          direction: "push",
          request: { reason },
          ...(queueJobId ? { queueJobId } : {}),
        },
        (connector, shop) =>
          connector.orders.cancelOrder(shop, {
            externalOrderId: o.externalOrderId,
            externalStatus: o.externalStatus ?? "",
            reason,
            items: items
              .filter((i) => i.qty - i.cancelledQty > 0 && i.externalProductId)
              .map((i) => ({
                externalItemId: i.externalProductId!,
                externalVariantId: i.externalSkuId ?? "",
                quantity: i.qty - i.cancelledQty,
              })),
          }),
      );
    } catch (err) {
      if (isConnectorError(err) && err.kind === "transient") throw err;
      const { message } = describeSyncError(err);
      await withTenantTx(this.db, ctx, (tx) =>
        this.repo.insertEvents(tx, [
          {
            id: newId(),
            tenantId: ctx.tenantId,
            orderId,
            type: "cancel_failed",
            actorType: "system",
            actorId: null,
            payload: { reason, message },
          },
        ]),
      );
      if (!isConnectorError(err)) throw err;
      return false;
    }
    await this.refresh(ctx, o.storeId, [o.externalOrderId], {
      source: "webhook",
      ...(queueJobId ? { queueJobId } : {}),
    });
    return true;
  }
}
