import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { dataOf, ListingsService } from "../catalog/listings.service";
import { storeNotFound } from "../channel/channel.errors";
import { StoresService } from "../channel/stores.service";
import { ordersImporting } from "./inventory.errors";
import { InventoryRepository } from "./inventory.repository";
import { InventoryService } from "./inventory.service";
import { stockKey } from "./stock-plan";

export type InitialStockStatus =
  /** on-hand set from the marketplace */
  | "set"
  /** the marketplace matches what OmniSeller has: confirmed without a movement */
  | "confirmed"
  /** someone already established this stock; left alone */
  | "already_set"
  /** the warehouse is outside the caller's warehouse scope */
  | "out_of_scope";

export interface InitialStockLine {
  variantId: string;
  sku: string;
  variantName: string;
  productName: string;
  warehouseId: string;
  marketplaceQty: number;
  onHandBefore: number;
  onHandAfter: number;
  status: InitialStockStatus;
}

/**
 * Initial stock from a connected store (onboarding step "periksa stok awal", UI 15.1; PRD FR-STK-01):
 * for every mapped listing, the seller stock the marketplace reported at the last pull becomes the
 * on-hand quantity of the OmniSeller warehouse its location is mapped to. Only stock nobody has
 * established yet is touched, so running it again never overwrites a count. On-hand is set to the
 * marketplace quantity plus what OmniSeller already holds for unshipped orders, so the available
 * quantity equals what buyers could buy at the marketplace.
 */
@Injectable()
export class InitialStockService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(InventoryRepository) private readonly repo: InventoryRepository,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(StoresService) private readonly stores: StoresService,
  ) {}

  async fromStore(
    ctx: RequestContext,
    storeId: string,
    dryRun: boolean,
  ): Promise<{ storeId: string; dryRun: boolean; lines: InitialStockLine[] }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      if (!this.stores.inScope(ctx, storeId)) throw storeNotFound();
      const target = (await this.stores.stockTargetsIn(tx, [storeId])).get(storeId);
      if (!target) throw storeNotFound();
      // open orders reserve stock as they are imported; counting before that would hold them twice
      if (!target.store.lastOrderSyncAt) throw ordersImporting();

      const byExternal = new Map(target.warehouses.map((w) => [w.externalWarehouseId, w]));
      const sellers = target.warehouses.filter((w) => w.active && w.kind === "seller");
      // marketplace quantity per (variant, warehouse): summed over a listing's locations, and the
      // largest over several listings of the same variant (they show the same physical stock)
      const found = new Map<string, { variantId: string; warehouseId: string; qty: number }>();
      for (const l of await this.listings.mappedInStoreIn(tx, storeId)) {
        const stock = dataOf(l).stockByWarehouse ?? {};
        const entries: [string, number][] = Object.entries(stock);
        if (entries.length === 0 && l.stockAtChannel !== null && sellers.length === 1) {
          entries.push([sellers[0]!.externalWarehouseId, l.stockAtChannel]);
        }
        const perWarehouse = new Map<string, number>();
        for (const [key, qty] of entries) {
          const cw = byExternal.get(key) ?? (sellers.length === 1 ? sellers[0] : undefined);
          if (!cw?.active || cw.kind !== "seller" || cw.mappingStatus !== "mapped" || !cw.warehouseId) continue;
          perWarehouse.set(cw.warehouseId, (perWarehouse.get(cw.warehouseId) ?? 0) + Math.max(qty, 0));
        }
        for (const [warehouseId, qty] of perWarehouse) {
          const k = stockKey(l.variantId!, warehouseId);
          const prev = found.get(k);
          if (!prev || qty > prev.qty) found.set(k, { variantId: l.variantId!, warehouseId, qty });
        }
      }

      const wanted = [...found.values()];
      const variantIds = [...new Set(wanted.map((f) => f.variantId))];
      const rows = new Map(
        (
          await this.repo.rows(
            tx,
            variantIds,
            wanted.map((f) => f.warehouseId),
          )
        ).map((r) => [stockKey(r.variantId, r.warehouseId), r]),
      );
      const variants = await this.repo.variants(tx, variantIds);
      const visible = new Set((await this.inventory.warehousesIn(tx, ctx)).map((w) => w.id));

      const lines: InitialStockLine[] = [];
      for (const f of wanted) {
        const variant = variants.get(f.variantId);
        if (!variant) continue;
        const row = rows.get(stockKey(f.variantId, f.warehouseId));
        const before = row?.onHand ?? 0;
        const after = f.qty + (row?.reserved ?? 0) + (row?.buffer ?? 0);
        const status: InitialStockStatus = !visible.has(f.warehouseId)
          ? "out_of_scope"
          : row?.stockSetAt
            ? "already_set"
            : after === before
              ? "confirmed"
              : "set";
        lines.push({
          variantId: f.variantId,
          sku: variant.sku,
          variantName: variant.variantName,
          productName: variant.productName,
          warehouseId: f.warehouseId,
          marketplaceQty: f.qty,
          onHandBefore: before,
          onHandAfter: status === "set" ? after : before,
          status,
        });
      }
      lines.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

      if (!dryRun) {
        const apply = lines.filter((l) => l.status === "set" || l.status === "confirmed");
        await this.inventory.establishIn(
          tx,
          ctx,
          apply.map((l, i) => ({
            variantId: l.variantId,
            warehouseId: l.warehouseId,
            onHand: l.onHandAfter,
            path: `lines.${i}`,
          })),
          { type: "migration_initial", note: `Stok awal dari ${target.store.name}` },
        );
      }
      return { storeId, dryRun, lines };
    });
  }
}
