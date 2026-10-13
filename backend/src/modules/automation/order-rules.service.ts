import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { findPgError } from "../../common/errors/problem";
import { type ExportSheet, singlePage } from "../../common/export-sheet";
import type { DbHandle, Tx } from "../../db/client";
import type { OrderRuleActions, OrderRuleConditions } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { isManualChannel, StoresService } from "../channel/stores.service";
import { PrintService } from "../fulfillment/print.service";
import { DevicesService } from "../identity/devices.service";
import { TenantsService } from "../identity/tenants.service";
import { InventoryService } from "../inventory/inventory.service";
import { TagsService } from "../orders/tags.service";
import {
  orderRuleDuplicate,
  orderRuleInvalid,
  orderRuleLimit,
  orderRuleNotFound,
  orderRuleNotHeld,
  orderRuleOrderInvalid,
  orderRuleStale,
} from "./automation.errors";
import { type OrderRuleRow, OrderRulesRepository } from "./automation.repository";
import {
  actionPermissions,
  actionsProblem,
  conditionsProblem,
  MAX_ORDER_RULES,
  type NormalizedActions,
  normalizeActions,
  normalizeConditions,
} from "./automation-plan";
import { ScheduleRepository } from "./schedule.repository";

export interface OrderRule extends Omit<OrderRuleRow, "conditions" | "actions"> {
  conditions: Required<OrderRuleConditions>;
  actions: NormalizedActions;
  /** Orders waiting for the rule's time of day (UI L55). */
  pending: number;
}

export interface OrderRuleInput {
  name: string;
  active?: boolean | undefined;
  conditions?: OrderRuleConditions | undefined;
  actions: OrderRuleActions;
}

export type OrderRulePatch = Partial<OrderRuleInput>;

const NAME_INDEX = "order_rule_name_uq";

const view = (r: OrderRuleRow, pending = 0): OrderRule => ({
  ...r,
  conditions: normalizeConditions(r.conditions),
  actions: normalizeActions(r.actions),
  pending,
});

/**
 * Automatic order processing rules (PRD FR-ORD-19, UI L55, backend doc 8.37), from plan Growth on
 * (`auto_process`): made, changed, and ordered only while the plan has it, and run only then
 * (AutoProcessService); kept and deletable on any plan. Whoever saves a rule holds every permission its
 * actions need, and someone limited to some stores or warehouses keeps their rules inside them.
 */
@Injectable()
export class OrderRulesService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrderRulesRepository) private readonly repo: OrderRulesRepository,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(TagsService) private readonly tags: TagsService,
    @Inject(PrintService) private readonly print: PrintService,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(ScheduleRepository) private readonly schedules: ScheduleRepository,
  ) {}

  /** The rules the caller may manage, in the order they are checked. */
  list(ctx: RequestContext): Promise<OrderRule[]> {
    return withTenantTx(this.db, ctx, async (tx) =>
      (await this.viewsIn(tx)).filter((r) => this.inScope(ctx, r.conditions)),
    );
  }

  /** Active rules in the order they are checked, in the caller's transaction (the engine). */
  async activeIn(tx: Tx): Promise<OrderRule[]> {
    return (await this.repo.list(tx, true)).map((r) => view(r));
  }

  /** Every rule, switched off ones too, in the caller's transaction (the timed arrange). */
  async allIn(tx: Tx): Promise<OrderRule[]> {
    return (await this.repo.list(tx)).map((r) => view(r));
  }

  /** Every rule with the number of orders waiting for its time. */
  private async viewsIn(tx: Tx): Promise<OrderRule[]> {
    const pending = await this.schedules.countByRule(tx);
    return (await this.repo.list(tx)).map((r) => view(r, pending.get(r.id) ?? 0));
  }

  private async viewIn(tx: Tx, id: string): Promise<OrderRule> {
    return view((await this.repo.get(tx, id))!, (await this.schedules.countByRule(tx)).get(id) ?? 0);
  }

  create(ctx: RequestContext, input: OrderRuleInput): Promise<OrderRule> {
    return this.named(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        await this.tenants.requireFeatureIn(tx, ctx, "auto_process");
        const { rules, lastPriority } = await this.repo.count(tx);
        if (rules >= MAX_ORDER_RULES) throw orderRuleLimit(MAX_ORDER_RULES);
        const conditions = normalizeConditions(input.conditions ?? {});
        const actions = normalizeActions(input.actions);
        await this.checkIn(tx, ctx, conditions, actions);
        const name = input.name.trim();
        if (await this.repo.nameTaken(tx, name)) throw orderRuleDuplicate();
        const id = newId();
        await this.repo.insert(tx, {
          id,
          tenantId: ctx.tenantId,
          name,
          priority: lastPriority + 1,
          active: input.active ?? true,
          conditions,
          actions,
          createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
        });
        return this.viewIn(tx, id);
      }),
    );
  }

  /**
   * Changes a rule. The caller holds what it did and what it will do; a change to its conditions or
   * actions is checked like a new rule, so switching a rule off never fails over a deleted tag.
   */
  update(ctx: RequestContext, id: string, patch: OrderRulePatch, ifMatch?: number): Promise<OrderRule> {
    return this.named(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        const current = await this.visibleIn(tx, ctx, id);
        if (ifMatch !== undefined && current.rowVersion !== ifMatch) throw orderRuleStale();
        await this.tenants.requireFeatureIn(tx, ctx, "auto_process");
        this.holds(ctx, current.actions);
        const conditions = patch.conditions ? normalizeConditions(patch.conditions) : current.conditions;
        const actions = patch.actions ? normalizeActions(patch.actions) : current.actions;
        if (patch.conditions || patch.actions) await this.checkIn(tx, ctx, conditions, actions);
        const name = patch.name?.trim();
        if (name !== undefined && (await this.repo.nameTaken(tx, name, id))) throw orderRuleDuplicate();
        await this.repo.update(tx, id, {
          ...(name !== undefined ? { name } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          ...(patch.conditions ? { conditions } : {}),
          ...(patch.actions ? { actions } : {}),
        });
        return this.viewIn(tx, id);
      }),
    );
  }

  /** Deletes a rule, on any plan: a business that moved down can still clear its rules. */
  async remove(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      await this.visibleIn(tx, ctx, id);
      await this.repo.remove(tx, id);
    });
  }

  /**
   * The order rules are checked in (L55 drag or arrows): `ids` are all the rules the caller manages, first
   * checked first. They take the places they held among the others, so someone limited to some stores
   * reorders only their own; for everyone else the rules are numbered 1, 2, 3 again.
   */
  reorder(ctx: RequestContext, ids: string[]): Promise<OrderRule[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.tenants.requireFeatureIn(tx, ctx, "auto_process");
      const all = await this.viewsIn(tx);
      const mine = all.filter((r) => this.inScope(ctx, r.conditions));
      const wanted = new Set(ids);
      if (wanted.size !== ids.length || ids.length !== mine.length || mine.some((r) => !wanted.has(r.id))) {
        throw orderRuleOrderInvalid();
      }
      const slots =
        mine.length === all.length ? mine.map((_, i) => i + 1) : mine.map((r) => r.priority).sort((a, b) => a - b);
      for (const [i, id] of ids.entries()) {
        const rule = mine.find((r) => r.id === id)!;
        // switching a rule's turn is acting with it, as saving it is
        if (rule.priority !== slots[i]) {
          this.holds(ctx, rule.actions);
          await this.repo.update(tx, id, { priority: slots[i]! });
        }
      }
      return (await this.viewsIn(tx)).filter((r) => this.inScope(ctx, r.conditions));
    });
  }

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "aturan_otomatis.csv",
        description:
          "Aturan proses pesanan otomatis, urut seperti diperiksa; daftar dipisah koma, kondisi kosong berarti semua.",
        columns: [
          "urutan",
          "nama",
          "aktif",
          "toko",
          "kurir",
          "gudang_asal",
          "sku",
          "jenis_paket",
          "total_min",
          "total_maks",
          "hanya_jam_operasional",
          "pindah_ke_gudang",
          "tag",
          "terima",
          "atur_pengiriman",
          "jam_atur",
          "cetak_ke_agen",
          "cetak_format",
          "cetak_daftar_kemas",
        ],
        pages: (tx, lookups) =>
          singlePage(async () => {
            const rules = (await this.repo.list(tx)).map((r) => view(r));
            const tagIds = rules.flatMap((r) => r.actions.tagIds);
            const tags = new Map((await this.tags.liveIn(tx, tagIds)).map((t) => [t.id, t.name]));
            const agents = rules.some((r) => r.actions.print) ? await this.devices.namesIn(tx) : new Map();
            const list = (names: (string | null | undefined)[]) => names.filter((n) => !!n).join(", ");
            return rules.map((r) => [
              r.priority,
              r.name,
              r.active,
              list(r.conditions.storeIds.map((id) => lookups.storeName(id))),
              r.conditions.couriers.join(", "),
              list(r.conditions.warehouseIds.map((id) => lookups.warehouseCode(id))),
              r.conditions.skus.join(", "),
              r.conditions.items,
              r.conditions.minTotal,
              r.conditions.maxTotal,
              r.conditions.withinOperatingHours,
              lookups.warehouseCode(r.actions.warehouseId),
              list(r.actions.tagIds.map((id) => tags.get(id))),
              r.actions.accept,
              r.actions.arrange,
              r.actions.arrangeAt,
              r.actions.print ? (agents.get(r.actions.print.deviceId) ?? r.actions.print.deviceId) : null,
              r.actions.print?.format ?? null,
              r.actions.print ? r.actions.print.packingList : null,
            ]);
          }),
      },
    ];
  }

  private async visibleIn(tx: Tx, ctx: RequestContext, id: string): Promise<OrderRule> {
    const row = await this.repo.get(tx, id, true);
    const rule = row ? view(row) : undefined;
    if (!rule || !this.inScope(ctx, rule.conditions)) throw orderRuleNotFound();
    return rule;
  }

  /**
   * A rule acts on the stores and warehouses its conditions name, or on all of them: someone limited to
   * some stores or warehouses manages only rules that name some of theirs and nothing else.
   */
  private inScope(ctx: RequestContext, c: Required<OrderRuleConditions>): boolean {
    const within = (scope: ReadonlySet<string> | null, ids: string[]) =>
      scope === null || (ids.length > 0 && ids.every((id) => scope.has(id)));
    return within(ctx.storeScope, c.storeIds) && within(ctx.warehouseScope, c.warehouseIds);
  }

  private holds(ctx: RequestContext, actions: OrderRuleActions): void {
    for (const p of actionPermissions(actions)) if (!ctx.permissions.has(p)) throw orderRuleNotHeld(p);
  }

  /** What a rule names exists and is the caller's to name, it does something, and its caller may do it. */
  private async checkIn(
    tx: Tx,
    ctx: RequestContext,
    c: Required<OrderRuleConditions>,
    a: NormalizedActions,
  ): Promise<void> {
    const problem = actionsProblem(a);
    if (problem) throw orderRuleInvalid(problem.path, problem.message);
    const range = conditionsProblem(c);
    if (range) throw orderRuleInvalid("conditions.maxTotal", range);
    this.holds(ctx, a);
    if (ctx.storeScope !== null && c.storeIds.length === 0) {
      throw orderRuleInvalid("conditions.storeIds", "Pilih toko: Anda hanya mengelola sebagian toko.");
    }
    if (ctx.warehouseScope !== null && c.warehouseIds.length === 0) {
      throw orderRuleInvalid("conditions.warehouseIds", "Pilih gudang: Anda hanya mengelola sebagian gudang.");
    }
    const stores = await this.stores.stockTargetsIn(tx, c.storeIds);
    for (const [i, id] of c.storeIds.entries()) {
      const s = stores.get(id)?.store;
      if (!s || (ctx.storeScope !== null && !ctx.storeScope.has(id))) {
        throw orderRuleInvalid(`conditions.storeIds.${i}`, "Toko tidak ditemukan.");
      }
      if (isManualChannel(s.channel)) {
        throw orderRuleInvalid(`conditions.storeIds.${i}`, "Aturan otomatis hanya untuk pesanan toko marketplace.");
      }
    }
    const warehouses = new Set((await this.inventory.warehousesIn(tx, ctx)).map((w) => w.id));
    for (const [i, id] of c.warehouseIds.entries()) {
      if (!warehouses.has(id)) throw orderRuleInvalid(`conditions.warehouseIds.${i}`, "Gudang tidak ditemukan.");
    }
    if (a.warehouseId && !warehouses.has(a.warehouseId)) {
      throw orderRuleInvalid("actions.warehouseId", "Gudang tidak ditemukan.");
    }
    const tags = new Set((await this.tags.liveIn(tx, a.tagIds)).map((t) => t.id));
    for (const [i, id] of a.tagIds.entries()) {
      if (!tags.has(id)) throw orderRuleInvalid(`actions.tagIds.${i}`, "Tag tidak ditemukan.");
    }
    if (a.print) {
      // the agent exists, is not revoked, and serves the caller's warehouses (FR-SHP-18)
      const agent = await this.print.agentIn(tx, ctx, a.print.deviceId, "actions.print.deviceId");
      // an agent of one warehouse prints only orders of that warehouse: the rule must keep them there
      const keeps =
        a.warehouseId === agent.warehouseId || (c.warehouseIds.length === 1 && c.warehouseIds[0] === agent.warehouseId);
      if (agent.warehouseId && !keeps) {
        throw orderRuleInvalid(
          "actions.print.deviceId",
          `Agen cetak ${agent.name} melayani satu gudang: batasi aturan ke gudang itu, atau pindahkan pesanan ke sana.`,
        );
      }
    }
  }

  /** Two rules saved with one name at once: the unique index answers (the transaction rolled back). */
  private async named<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (findPgError(e)?.constraint === NAME_INDEX) throw orderRuleDuplicate();
      throw e;
    }
  }
}
