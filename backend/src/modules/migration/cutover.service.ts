import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { StoresService } from "../channel/stores.service";
import {
  cutoverAlreadyUndone,
  cutoverChecklistFailed,
  cutoverNotFound,
  cutoverUndoExpired,
  nothingToCutover,
  oldAppNotConfirmed,
} from "./migration.errors";
import { type CutoverRow, MigrationRepository } from "./migration.repository";
import { ParallelModeService, type StoreState, UNDO_WINDOW_MS } from "./parallel-mode.service";

/**
 * Cutover (PRD FR-MIG-06, UI L46 step 5, backend doc 8.19): stores in parallel mode go live in one
 * transaction once each one's checklist passes (store connected, 90-day orders imported, warehouses and
 * listings mapped, marketplace stock pulled within the hour and equal to what OmniSeller would send,
 * the old app's authorization revoked). Any failing store stops them all. Going live starts the stock
 * push and lets sellers process orders here; it can be undone within 24 hours.
 */
@Injectable()
export class CutoverService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(MigrationRepository) private readonly repo: MigrationRepository,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(ParallelModeService) private readonly parallel: ParallelModeService,
  ) {}

  /** The checklist of the given stores in parallel mode, or of all of them. */
  async check(ctx: RequestContext, storeIds: string[] | undefined): Promise<StoreState[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const stores = storeIds?.length
        ? await this.stores.lockIn(tx, ctx, storeIds)
        : (await this.stores.listIn(tx, ctx)).filter((s) => s.syncMode === "read_only" && s.status !== "disconnected");
      const now = new Date();
      const out: StoreState[] = [];
      for (const s of stores) out.push(await this.parallel.stateIn(tx, ctx, s, now));
      return out;
    });
  }

  async cutover(
    ctx: RequestContext,
    input: { storeIds?: string[] | undefined; oldAppRevoked: boolean },
  ): Promise<CutoverRow[]> {
    if (!input.oldAppRevoked) throw oldAppNotConfirmed();
    return withTenantTx(this.db, ctx, async (tx) => {
      const ids = input.storeIds?.length
        ? input.storeIds
        : (await this.stores.listIn(tx, ctx))
            .filter((s) => s.syncMode === "read_only" && s.status !== "disconnected")
            .map((s) => s.id);
      if (ids.length === 0) throw nothingToCutover();
      const stores = await this.stores.lockIn(tx, ctx, ids);
      const now = new Date();
      const states: StoreState[] = [];
      const failed: { storeId: string; name: string; failed: { key: string; detail: string | null }[] }[] = [];
      for (const store of stores) {
        if (store.syncMode === "live") {
          failed.push({
            storeId: store.id,
            name: store.name,
            failed: [{ key: "already_live", detail: "Toko ini sudah memakai OmniSeller sepenuhnya." }],
          });
          continue;
        }
        const state = await this.parallel.stateIn(tx, ctx, store, now, { oldAppRevoked: true });
        const bad = state.checklist.filter((i) => i.blocking && !i.ok);
        if (bad.length > 0) {
          failed.push({
            storeId: store.id,
            name: store.name,
            failed: bad.map((i) => ({ key: i.key, detail: i.detail })),
          });
        }
        states.push(state);
      }
      if (failed.length > 0) throw cutoverChecklistFailed(failed);

      const done: CutoverRow[] = [];
      for (const s of states) {
        await this.stores.setSyncModeIn(tx, ctx, s.store, "live");
        done.push(
          await this.repo.insertCutover(tx, {
            id: newId(),
            tenantId: ctx.tenantId,
            storeId: s.store.id,
            status: "done",
            checklist: {
              checks: s.checklist.map((i) => ({ key: i.key, ok: i.ok, detail: i.detail })),
              oldAppRevoked: true,
              stock: { match: s.stock.counts.match, differ: s.stock.counts.differ, unset: s.stock.counts.unset },
            },
            undoUntil: new Date(now.getTime() + UNDO_WINDOW_MS),
            performedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
          }),
        );
      }
      return done;
    });
  }

  /** Back to parallel mode within 24 hours: OmniSeller stops sending stock and processing orders. */
  async undo(ctx: RequestContext, id: string): Promise<CutoverRow> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.repo.getCutover(tx, id, true);
      if (!c || !this.stores.inScope(ctx, c.storeId)) throw cutoverNotFound();
      if (c.status === "undone") throw cutoverAlreadyUndone();
      const now = new Date();
      if (now.getTime() > c.undoUntil.getTime()) throw cutoverUndoExpired();
      const [store] = await this.stores.lockIn(tx, ctx, [c.storeId]);
      await this.stores.setSyncModeIn(tx, ctx, store!, "read_only");
      await this.repo.updateCutover(tx, c.id, {
        status: "undone",
        undoneAt: now,
        undoneBy: ctx.actor.type === "user" ? ctx.actor.id : null,
      });
      return (await this.repo.getCutover(tx, c.id))!;
    });
  }

  async list(ctx: RequestContext): Promise<CutoverRow[]> {
    return withTenantTx(this.db, ctx, (tx) => this.repo.cutovers(tx, ctx.storeScope ? [...ctx.storeScope] : null, 50));
  }
}
