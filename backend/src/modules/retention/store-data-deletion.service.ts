import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { ListingsService } from "../catalog/listings.service";
import { storeDataDeletionRequested } from "../channel/channel.events";
import { StoresService } from "../channel/stores.service";
import { FulfillmentService } from "../fulfillment/fulfillment.service";
import { InventoryService } from "../inventory/inventory.service";
import { CategoriesService } from "../listing-copy/categories.service";
import { ListingCopyService } from "../listing-copy/listing-copy.service";
import { OrdersService } from "../orders/orders.service";
import { ReturnsService } from "../returns/returns.service";
import { SyncLogService } from "../sync/sync-log.service";

const log = logger.forModule("retention");

/** Rows per transaction: orders (with their shipments), listings, sync log entries. */
const ORDER_BATCH = 200;
const LISTING_BATCH = 500;
const SYNC_LOG_BATCH = 1000;
/** Listing copies (each with its drafts) and cached categories. */
const COPY_BATCH = 50;
const RETURN_BATCH = 500;
const CATEGORY_BATCH = 2000;
/** One job works this long, then the rest continues in the next job (a large store takes several). */
export const DELETION_BUDGET_MS = 20_000;

export type DeletionOutcome = "done" | "continued" | "skipped";

/**
 * FR-INT-07 (backend doc 8.23): deletes the data of a store disconnected without keeping it, through the
 * services of the modules that own it: orders with their shipments (stock they still hold is released
 * first; label files and printed documents expire now), listings, stock allocation rules, the sync log,
 * marketplace warehouses, sync cursors, listing copies from or to the store with their drafts, and its
 * cached marketplace categories. Batches run in short transactions; stock movements and the
 * audit log stay, since they record what happened to stock and who did what. The store row stays as a
 * marker with `data_deleted_at`.
 */
@Injectable()
export class StoreDataDeletionService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(SyncLogService) private readonly syncLog: SyncLogService,
    @Inject(ListingCopyService) private readonly copies: ListingCopyService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(ReturnsService) private readonly returns: ReturnsService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  async run(ctx: RequestContext, storeId: string, budgetMs = DELETION_BUDGET_MS): Promise<DeletionOutcome> {
    const store = await withTenantTx(this.db, ctx, (tx) => this.stores.rowIn(tx, storeId));
    if (!store?.dataDeletionRequestedAt || store.dataDeletedAt || store.status !== "disconnected") return "skipped";
    const until = Date.now() + budgetMs;
    const steps: [string, number, (tx: Tx) => Promise<number>][] = [
      // requests name their orders: they go first
      ["returns", RETURN_BATCH, (tx) => this.returns.deleteStoreReturnsIn(tx, storeId, RETURN_BATCH)],
      [
        "orders",
        ORDER_BATCH,
        async (tx) => {
          const ids = await this.orders.storeOrderIdsIn(tx, storeId, ORDER_BATCH);
          await this.fulfillment.deleteForOrdersIn(tx, ids);
          return this.orders.deleteOrdersIn(tx, ctx, ids);
        },
      ],
      ["listings", LISTING_BATCH, (tx) => this.listings.deleteStoreListingsIn(tx, storeId, LISTING_BATCH)],
      ["listing_copies", COPY_BATCH, (tx) => this.copies.deleteStoreCopiesIn(tx, storeId, COPY_BATCH)],
      ["categories", CATEGORY_BATCH, (tx) => this.categories.deleteStoreCategoriesIn(tx, storeId, CATEGORY_BATCH)],
      ["sync_log", SYNC_LOG_BATCH, (tx) => this.syncLog.deleteStoreLogIn(tx, storeId, SYNC_LOG_BATCH)],
    ];
    const deleted: Record<string, number> = {};
    for (const [name, batch, step] of steps) {
      for (;;) {
        const n = await withTenantTx(this.db, ctx, step);
        deleted[name] = (deleted[name] ?? 0) + n;
        if (n < batch) break;
        if (Date.now() > until) {
          await withTenantTx(this.db, ctx, (tx) =>
            this.outbox.enqueue(tx, ctx, storeDataDeletionRequested, { storeId }, storeId),
          );
          log.info({ store_id: storeId, deleted }, "store data deletion continues");
          return "continued";
        }
      }
    }
    await withTenantTx(this.db, ctx, async (tx) => {
      await this.inventory.deleteStoreRulesIn(tx, storeId);
      await this.stores.finishDataDeletionIn(tx, storeId);
    });
    log.info({ store_id: storeId, deleted }, "store data deleted");
    return "done";
  }
}
