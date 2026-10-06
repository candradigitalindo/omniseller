import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { ConflictError } from "../../common/errors/domain-errors";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { channelWarehouseNotFound, storeIsManual, storeNotFound } from "../channel/channel.errors";
import { isManualChannel, StoresService } from "../channel/stores.service";
import { ruleDuplicate, ruleInvalid, ruleNotFound, storeNotLive, variantNotFound } from "./inventory.errors";
import { stockResyncRequested } from "./inventory.events";
import { InventoryRepository, type RuleRow } from "./inventory.repository";
import type { RuleMode } from "./stock-plan";

export interface RuleInput {
  storeId: string;
  channelWarehouseId?: string | null | undefined;
  variantId?: string | null | undefined;
  mode: RuleMode;
  value?: number | undefined;
  buffer?: number | undefined;
  priority?: number | undefined;
  active?: boolean | undefined;
}

export type RulePatch = Partial<Pick<RuleInput, "mode" | "value" | "buffer" | "priority" | "active">>;

/** A rule with the SKU and name of its variant, so a list can say which product it holds back. */
export type RuleWithVariant = RuleRow & { variant: { sku: string; productName: string; variantName: string } | null };

function checkValue(mode: RuleMode, value: number): void {
  if (mode === "percent" && value > 100) throw ruleInvalid("value", "Persentase paling besar 100.");
}

/**
 * Stock allocation rules per store (PRD FR-STK-04, FR-WHS-05): how much of the available stock a
 * store shows, for every warehouse and variant or for one of them, with a safety buffer. A change
 * pushes the covered variants again; the pusher sends only values that changed.
 */
@Injectable()
export class AllocationRulesService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(InventoryRepository) private readonly repo: InventoryRepository,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  async list(ctx: RequestContext, storeId?: string): Promise<RuleWithVariant[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const visible = (await this.stores.listIn(tx, ctx)).map((s) => s.id);
      return this.withVariants(
        tx,
        await this.repo.rules(tx, storeId ? visible.filter((id) => id === storeId) : visible),
      );
    });
  }

  async create(ctx: RequestContext, input: RuleInput): Promise<RuleWithVariant> {
    const id = newId();
    await this.unique(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        if (!this.stores.inScope(ctx, input.storeId)) throw storeNotFound();
        const target = (await this.stores.stockTargetsIn(tx, [input.storeId])).get(input.storeId);
        if (!target) throw storeNotFound();
        // manual sales channels sell from OmniSeller's own stock: nothing is pushed to them
        if (isManualChannel(target.store.channel)) throw storeIsManual();
        if (input.channelWarehouseId) {
          const cw = target.warehouses.find((w) => w.id === input.channelWarehouseId);
          if (cw?.kind !== "seller") throw channelWarehouseNotFound();
        }
        if (input.variantId && !(await this.repo.variants(tx, [input.variantId])).has(input.variantId)) {
          throw variantNotFound("variantId");
        }
        checkValue(input.mode, input.value ?? 0);
        await this.repo.insertRule(tx, {
          id,
          tenantId: ctx.tenantId,
          storeId: input.storeId,
          channelWarehouseId: input.channelWarehouseId ?? null,
          variantId: input.variantId ?? null,
          mode: input.mode,
          value: input.value ?? 0,
          buffer: input.buffer ?? 0,
          priority: input.priority ?? 100,
          active: input.active ?? true,
        });
        await this.resyncIn(tx, ctx, input.storeId, input.variantId ?? null);
      }),
    );
    return this.get(ctx, id);
  }

  async get(ctx: RequestContext, id: string): Promise<RuleWithVariant> {
    return withTenantTx(this.db, ctx, async (tx) => (await this.withVariants(tx, [await this.load(tx, ctx, id)]))[0]!);
  }

  async update(ctx: RequestContext, id: string, patch: RulePatch, ifMatch?: number): Promise<RuleWithVariant> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const rule = await this.load(tx, ctx, id, true);
      if (ifMatch !== undefined && rule.rowVersion !== ifMatch) {
        throw new ConflictError("row.stale", "Data sudah diubah orang lain. Muat ulang lalu coba lagi.");
      }
      checkValue(patch.mode ?? rule.mode, patch.value ?? rule.value);
      await this.repo.updateRule(tx, id, patch);
      await this.resyncIn(tx, ctx, rule.storeId, rule.variantId);
    });
    return this.get(ctx, id);
  }

  async remove(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const rule = await this.load(tx, ctx, id, true);
      await this.repo.deleteRule(tx, id);
      await this.resyncIn(tx, ctx, rule.storeId, rule.variantId);
    });
  }

  /** "Dorong ulang stok": sends every value of a live store again, even ones the marketplace has. */
  async requestResync(ctx: RequestContext, storeId: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      if (!this.stores.inScope(ctx, storeId)) throw storeNotFound();
      const target = (await this.stores.stockTargetsIn(tx, [storeId])).get(storeId);
      if (!target) throw storeNotFound();
      if (isManualChannel(target.store.channel)) throw storeIsManual();
      if (!target.usable || target.store.syncMode !== "live") throw storeNotLive();
      await this.outbox.enqueue(tx, ctx, stockResyncRequested, { storeId, force: true }, storeId);
    });
  }

  private async withVariants(tx: Tx, rows: RuleRow[]): Promise<RuleWithVariant[]> {
    const variants = await this.repo.variants(tx, [
      ...new Set(rows.flatMap((r) => (r.variantId ? [r.variantId] : []))),
    ]);
    return rows.map((r) => {
      const v = r.variantId ? variants.get(r.variantId) : undefined;
      return { ...r, variant: v ? { sku: v.sku, productName: v.productName, variantName: v.variantName } : null };
    });
  }

  private async load(tx: Tx, ctx: RequestContext, id: string, forUpdate = false): Promise<RuleRow> {
    const rule = await this.repo.getRule(tx, id, forUpdate);
    if (!rule || !this.stores.inScope(ctx, rule.storeId)) throw ruleNotFound();
    return rule;
  }

  private async resyncIn(tx: Tx, ctx: RequestContext, storeId: string, variantId: string | null): Promise<void> {
    await this.outbox.enqueue(
      tx,
      ctx,
      stockResyncRequested,
      { storeId, ...(variantId ? { variantIds: [variantId] } : {}), force: false },
      storeId,
    );
  }

  private async unique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } };
      if ((e.code ?? e.cause?.code) === "23505") throw ruleDuplicate();
      throw err;
    }
  }
}
