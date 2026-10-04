import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { ListingsService } from "../catalog/listings.service";
import type { StoreRow } from "../channel/channel.repository";
import { StoresService } from "../channel/stores.service";
import {
  type ComparisonStatus,
  StockComparisonService,
  type StoreComparison,
} from "../inventory/stock-comparison.service";
import { OrdersService } from "../orders/orders.service";
import { type CutoverRow, MigrationRepository } from "./migration.repository";

/** Marketplace stock older than this is pulled again before a cutover counts it as checked. */
export const STOCK_FRESH_MS = 60 * 60_000;
/** Parallel mode is advised to run this long with no stock difference (PRD 18.3). */
export const PARALLEL_DAYS_ADVISED = 3;
/** A cutover can be undone this long (FR-MIG-06). */
export const UNDO_WINDOW_MS = 24 * 3600_000;

export interface ChecklistItem {
  key:
    | "store_connected"
    | "orders_imported"
    | "warehouses_mapped"
    | "listings_mapped"
    | "stock_fresh"
    | "stock_match"
    | "old_app_revoked"
    | "parallel_days"
    | "stock_unset";
  ok: boolean;
  /** Blocking items must pass before a cutover; the others are advice. */
  blocking: boolean;
  detail: string | null;
}

export interface StoreState {
  store: StoreRow;
  /** Since when the store has been in parallel mode; null when it is live. */
  parallelSince: Date | null;
  /** Orders received per status since then (live stores: since connecting). */
  orders: Record<string, number>;
  stock: {
    counts: Record<ComparisonStatus, number>;
    /** Listings OmniSeller would push to without a marketplace number to compare with. */
    unverified: number;
    pulledAt: Date | null;
    blocked: StoreComparison["blocked"];
  };
  unmappedListings: number;
  unmappedWarehouses: number;
  /** Parallel mode only. */
  checklist: ChecklistItem[];
  /** Every blocking item passes, the old app's revocation aside: it is confirmed with the cutover. */
  ready: boolean;
  lastCutover: CutoverRow | null;
}

const n = (x: number) => x.toLocaleString("id-ID");

/**
 * Parallel mode (PRD FR-MIG-05, UI L46 step 4, backend doc 8.19): OmniSeller reads orders and counts
 * stock for a store but sends nothing while the seller still works in the old app. Per store it
 * shows the orders received since then, the stock of both systems side by side
 * (StockComparisonService), and the cutover checklist (FR-MIG-06).
 */
@Injectable()
export class ParallelModeService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(MigrationRepository) private readonly repo: MigrationRepository,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(StockComparisonService) private readonly comparison: StockComparisonService,
  ) {}

  /** Every connected store in the caller's scope, parallel ones with their checklist. */
  async summary(ctx: RequestContext): Promise<StoreState[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const stores = (await this.stores.listIn(tx, ctx)).filter((s) => s.status !== "disconnected");
      const cutovers = await this.repo.cutovers(
        tx,
        stores.map((s) => s.id),
        200,
      );
      const now = new Date();
      const out: StoreState[] = [];
      for (const store of stores) {
        out.push(await this.stateIn(tx, ctx, store, now, { cutovers }));
      }
      return out;
    });
  }

  /** The side-by-side stock of one store (UI L46 step 4 table). */
  async comparisonOf(ctx: RequestContext, storeId: string): Promise<StoreComparison> {
    return withTenantTx(this.db, ctx, (tx) => this.comparison.compareIn(tx, ctx, storeId));
  }

  async stateIn(
    tx: Tx,
    ctx: RequestContext,
    store: StoreRow,
    now: Date,
    opts: { oldAppRevoked?: boolean; cutovers?: CutoverRow[] } = {},
  ): Promise<StoreState> {
    const parallel = store.syncMode === "read_only";
    const since = parallel ? (store.syncModeChangedAt ?? store.connectedAt ?? store.createdAt) : null;
    const comparison = await this.comparison.compareIn(tx, ctx, store.id);
    const unverified = comparison.lines.filter((l) => l.status === "unknown" && l.omniseller !== null).length;
    const unmappedListings = await this.listings.unmappedInStoreIn(tx, store.id);
    const unmappedWarehouses = await this.stores.unmappedWarehousesIn(tx, store.id);
    const orders = await this.orders.statusCountsIn(tx, ctx, store.id, since);
    const lastCutover =
      (opts.cutovers ?? (await this.repo.cutovers(tx, [store.id], 1))).find((c) => c.storeId === store.id) ?? null;

    const checklist: ChecklistItem[] = [];
    if (parallel) {
      const usable = store.status === "active" || store.status === "token_expiring";
      const fresh = comparison.pulledAt !== null && now.getTime() - comparison.pulledAt.getTime() <= STOCK_FRESH_MS;
      const { differ, unset } = comparison.counts;
      const days = since ? Math.floor((now.getTime() - since.getTime()) / 86_400_000) : 0;
      const item = (key: ChecklistItem["key"], ok: boolean, detail: string, blocking = true): ChecklistItem => ({
        key,
        ok,
        blocking,
        detail: ok ? null : detail,
      });
      checklist.push(
        item("store_connected", usable, "Toko perlu dihubungkan ulang."),
        item("orders_imported", store.lastOrderSyncAt !== null, "Impor pesanan 90 hari terakhir belum selesai."),
        item(
          "warehouses_mapped",
          unmappedWarehouses === 0,
          `${n(unmappedWarehouses)} gudang marketplace belum dipetakan.`,
        ),
        item("listings_mapped", unmappedListings === 0, `${n(unmappedListings)} listing belum terhubung ke produk.`),
        item(
          "stock_fresh",
          fresh,
          "Tarik ulang listing toko agar stok terbaru di marketplace ikut dibandingkan (berlaku 1 jam).",
        ),
        item(
          "stock_match",
          differ === 0 && unverified === 0 && comparison.blocked === null,
          [
            differ > 0 ? `${n(differ)} listing stoknya berbeda` : null,
            unverified > 0 ? `${n(unverified)} listing belum bisa dibandingkan` : null,
            comparison.blocked ? "stok belum bisa dihitung" : null,
          ]
            .filter(Boolean)
            .join(", ")
            .replace(/^./, (c) => c.toUpperCase())
            .concat("."),
        ),
        item(
          "old_app_revoked",
          opts.oldAppRevoked === true,
          "Cabut otorisasi aplikasi lama di Seller Center, lalu konfirmasi saat pindah.",
        ),
        item(
          "parallel_days",
          days >= PARALLEL_DAYS_ADVISED,
          `Mode uji berdampingan baru berjalan ${n(days)} hari; disarankan minimal ${PARALLEL_DAYS_ADVISED} hari dengan selisih stok nol.`,
          false,
        ),
        item(
          "stock_unset",
          unset === 0,
          `${n(unset)} listing belum punya stok di OmniSeller; stoknya tidak dikirim sampai ditetapkan (gunakan Stok awal dari toko).`,
          false,
        ),
      );
    }
    return {
      store,
      parallelSince: since,
      orders,
      stock: { counts: comparison.counts, unverified, pulledAt: comparison.pulledAt, blocked: comparison.blocked },
      unmappedListings,
      unmappedWarehouses,
      checklist,
      ready: parallel && checklist.every((i) => !i.blocking || i.ok || i.key === "old_app_revoked"),
      lastCutover,
    };
  }
}
