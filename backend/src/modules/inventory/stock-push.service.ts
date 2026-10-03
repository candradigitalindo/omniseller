import { Inject, Injectable } from "@nestjs/common";
import { isConnectorError, type StockUpdateResult, TransientConnectorError } from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, STOCK_DIRTY } from "../../infra/tokens";
import type { StockDirtySet, StockPair } from "../../jobs/stock-dirty";
import { dataOf, ListingsService } from "../catalog/listings.service";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { type StockTarget, StoresService } from "../channel/stores.service";
import { NotificationInboxService } from "../notification/inbox.service";
import { describeSyncError } from "../sync/connector-calls";
import { InventoryRepository, type PushResultRow } from "./inventory.repository";
import { toPlanStore, toRule } from "./stock-inputs";
import { type PlannedPush, planStockPush, type SkipReason, stockKey } from "./stock-plan";

const log = logger.forModule("inventory.stock_push");

/** Held while a job pushes a variant; long enough for a rate-limited batch, short enough to recover. */
const LOCK_MS = 10 * 60_000;

export interface PushSummary {
  variants: number;
  /** variants another job was pushing; marked dirty again for later */
  busy: number;
  pushed: number;
  failed: number;
  unchanged: number;
  skipped: Partial<Record<SkipReason, number>>;
}

/**
 * The stock pusher (backend doc 9.4, PRD FR-STK-03, FR-WHS-05): for a batch of debounced
 * (variant, warehouse) changes, computes every affected listing's quantities from current data and
 * sends the ones the marketplace does not have yet. Marketplace calls happen outside any transaction,
 * one gateway call per store, stores in parallel; results are recorded per listing and channel
 * warehouse. Temporary failures make the job fail so BullMQ retries it; values already accepted are
 * not sent again on the retry.
 */
@Injectable()
export class StockPushService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(InventoryRepository) private readonly repo: InventoryRepository,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
    @Inject(STOCK_DIRTY) private readonly dirty: StockDirtySet,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  async push(ctx: RequestContext, marks: StockPair[], queueJobId?: string): Promise<PushSummary> {
    const variantIds = [...new Set(marks.map((m) => m.variantId))];
    const token = newId();
    const locked: string[] = [];
    const busy: string[] = [];
    for (const v of variantIds) ((await this.dirty.tryLock(ctx.tenantId, v, token, LOCK_MS)) ? locked : busy).push(v);
    if (busy.length > 0) {
      await this.dirty.markMany(
        ctx.tenantId,
        marks.filter((m) => busy.includes(m.variantId)),
      );
    }
    const summary: PushSummary = {
      variants: locked.length,
      busy: busy.length,
      pushed: 0,
      failed: 0,
      unchanged: 0,
      skipped: {},
    };
    if (locked.length === 0) return summary;

    try {
      const data = await withTenantTx(this.db, ctx, async (tx) => {
        const listings = await this.listings.mappedForVariantsIn(tx, locked);
        const targets = await this.stores.stockTargetsIn(
          tx,
          listings.map((l) => l.storeId),
        );
        const warehouseIds = [
          ...new Set(
            [...targets.values()].flatMap((t) => t.warehouses.flatMap((w) => (w.warehouseId ? [w.warehouseId] : []))),
          ),
        ];
        return {
          listings,
          targets,
          rows: await this.repo.rows(tx, locked, warehouseIds),
          rules: await this.repo.rules(tx, [...targets.keys()]),
          states: await this.repo.states(
            tx,
            listings.map((l) => l.id),
          ),
        };
      });

      const outcomes = planStockPush({
        listings: data.listings.map((l) => ({
          id: l.id,
          storeId: l.storeId,
          variantId: l.variantId!,
          externalItemId: l.externalItemId,
          externalVariantId: l.externalVariantId,
          status: l.status,
          stockKeys: Object.keys(dataOf(l).stockByWarehouse ?? {}),
        })),
        stores: new Map([...data.targets].map(([id, t]) => [id, toPlanStore(t)])),
        stock: new Map(
          data.rows.map((r) => [
            stockKey(r.variantId, r.warehouseId),
            { available: r.available ?? 0, established: r.stockSetAt !== null },
          ]),
        ),
        rules: data.rules.map(toRule),
        states: data.states,
      });

      const byStore = new Map<string, PlannedPush[]>();
      for (const o of outcomes) {
        if (o.kind === "unchanged") summary.unchanged++;
        else if (o.kind === "skip") summary.skipped[o.reason] = (summary.skipped[o.reason] ?? 0) + 1;
        else byStore.set(o.listing.storeId, [...(byStore.get(o.listing.storeId) ?? []), o]);
      }

      const results: PushResultRow[] = [];
      let retry = false;
      await Promise.all(
        [...byStore].map(async ([storeId, pushes]) => {
          const answers = await this.send(ctx, storeId, pushes, queueJobId);
          pushes.forEach((p, i) => {
            const a = answers[i]!;
            if (a.ok) summary.pushed++;
            else {
              summary.failed++;
              if (a.retryable) retry = true;
            }
            for (const t of p.targets) {
              results.push({
                listingId: p.listing.id,
                channelWarehouseId: t.channelWarehouseId,
                ok: a.ok,
                retryable: !a.ok && !!a.retryable,
                quantity: t.quantity,
                error: a.ok ? null : (a.error ?? "Gagal mengirim stok."),
              });
            }
          });
        }),
      );
      if (results.length > 0) {
        await withTenantTx(this.db, ctx, async (tx) => {
          const refused = await this.repo.recordPush(tx, ctx.tenantId, results, new Date());
          await this.announceRefusals(tx, ctx, refused, data.targets);
        });
      }
      log.info({ ...summary, job_id: queueJobId }, "stock push finished");
      if (retry) {
        throw new TransientConnectorError({
          code: "stock_push_retry",
          message: "Sebagian stok belum terkirim karena marketplace sedang sibuk; akan dicoba lagi.",
        });
      }
      return summary;
    } finally {
      for (const v of locked) await this.dirty.unlock(ctx.tenantId, v, token);
    }
  }

  /** One gateway call per store; a marketplace failure of the whole call becomes a failure of each listing. */
  private async send(
    ctx: RequestContext,
    storeId: string,
    pushes: PlannedPush[],
    queueJobId: string | undefined,
  ): Promise<StockUpdateResult[]> {
    try {
      return await this.gateway.call(
        ctx,
        storeId,
        {
          kind: "stock.push",
          direction: "push",
          request: { listings: pushes.length },
          ...(queueJobId ? { queueJobId } : {}),
        },
        (connector, shop) =>
          connector.inventory.updateStock(
            shop,
            pushes.map((p) => p.update),
          ),
        (r) => ({
          ok: r.filter((x) => x.ok).length,
          failed: r
            .filter((x) => !x.ok)
            .slice(0, 20)
            .map((x) => ({ item: x.externalItemId, variant: x.externalVariantId, error: x.error })),
        }),
      );
    } catch (err) {
      // A bug is not a marketplace answer: fail the job loudly instead of recording it per listing.
      if (!isConnectorError(err)) throw err;
      const retryable = err.kind === "transient";
      const { message } = describeSyncError(err);
      return pushes.map((p) => ({
        externalItemId: p.update.externalItemId,
        externalVariantId: p.update.externalVariantId,
        ok: false,
        error: message,
        retryable,
      }));
    }
  }

  /**
   * Listings the marketplace refused for the first time in a row (stock under a promotion's reserve,
   * item deleted, warehouse incomplete): one notification per person who manages stores
   * (`settings:store`) and sees the store (FR-NTF-01 "sinkronisasi gagal"). Retries are not announced.
   */
  private async announceRefusals(
    tx: Tx,
    ctx: RequestContext,
    refused: PushResultRow[],
    targets: Map<string, StockTarget>,
  ): Promise<void> {
    if (refused.length === 0) return;
    const storeOf = new Map<string, string>();
    for (const [storeId, t] of targets) for (const w of t.warehouses) storeOf.set(w.id, storeId);
    const items = refused
      .map((r) => ({ ...r, storeId: storeOf.get(r.channelWarehouseId) ?? null }))
      .filter((r) => r.storeId !== null);
    await this.inbox.notifyScopedIn(tx, ctx, "settings:store", items, (theirs) => {
      const listings = [...new Set(theirs.map((t) => t.listingId))];
      const stores = [...new Set(theirs.map((t) => targets.get(t.storeId!)?.store.name ?? "Toko"))];
      return {
        kind: "sync.stock_push_failed",
        severity: "warning",
        title: `Stok ${listings.length} listing ditolak marketplace`,
        body: `${stores.join(", ")}: ${theirs[0]!.error ?? "Gagal mengirim stok."}`,
        data: {
          listings: theirs.slice(0, 50).map((t) => ({ listingId: t.listingId, storeId: t.storeId, error: t.error })),
        },
      };
    });
  }
}
