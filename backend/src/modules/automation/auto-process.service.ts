import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import { DomainError } from "../../common/errors/domain-errors";
import { hasFeature } from "../../common/plan-features";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { CourierCalendarService } from "../campaign/courier-calendar.service";
import { FulfillmentService } from "../fulfillment/fulfillment.service";
import { TenantsService } from "../identity/tenants.service";
import { type ActionResult, OrdersService } from "../orders/orders.service";
import { TagsService } from "../orders/tags.service";
import {
  type AutoAction,
  type AutoRunRecord,
  firstMatch,
  needsHours,
  type OrderFacts,
  openAt,
} from "./automation-plan";
import { OrderRulesService } from "./order-rules.service";

/** A line as the rules read it: the product's SKU when the listing is mapped, else the marketplace's. */
export function factsOf(
  o: { storeId: string; warehouseId: string | null; shippingProvider: string | null; total: number },
  lines: readonly { skuSnapshot: string; sku: string | null; units: number }[],
): OrderFacts {
  const skus = new Set<string>();
  for (const l of lines) {
    if (l.sku) skus.add(l.sku);
    if (l.skuSnapshot) skus.add(l.skuSnapshot);
  }
  return {
    storeId: o.storeId,
    warehouseId: o.warehouseId,
    courier: o.shippingProvider,
    skus: [...skus],
    units: lines.reduce((n, l) => n + l.units, 0),
    total: o.total,
  };
}

/**
 * Automatic order processing (PRD FR-ORD-19, backend doc 8.37), worker only: a new marketplace order is
 * checked against the business's active rules by priority, and the first that matches acts on it as the
 * system, through the same services as the buttons (choose a warehouse, tag, accept, arrange the
 * shipment), each refused for the same reasons. One rule, once per order; what was done and refused goes
 * into the order's history. Nothing runs while the plan lacks `auto_process`.
 */
@Injectable()
export class AutoProcessService {
  private readonly log = logger.forModule("automation");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrderRulesService) private readonly rules: OrderRulesService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(TagsService) private readonly tags: TagsService,
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(CourierCalendarService) private readonly calendar: CourierCalendarService,
  ) {}

  /** Runs the first matching rule on the order; null when none acted. `now` decides operating hours. */
  async run(ctx: RequestContext, orderId: string, now = new Date()): Promise<AutoRunRecord | null> {
    const chosen = await withTenantTx(this.db, ctx, async (tx) => {
      const rules = await this.rules.activeIn(tx);
      if (rules.length === 0) return null;
      // rules wait while the plan lacks the feature, and run again after a move up
      if (!hasFeature(await this.tenants.planIn(tx, ctx), "auto_process")) return null;
      const candidate = await this.orders.autoCandidateIn(tx, orderId);
      if (!candidate) return null;
      const open = needsHours(rules) ? openAt(await this.calendar.businessHoursIn(tx, ctx), now) : true;
      const rule = firstMatch(rules, factsOf(candidate.order, candidate.lines), open);
      return rule ? { rule, warehouseId: candidate.order.warehouseId } : null;
    });
    if (!chosen) return null;
    const { rule } = chosen;
    const a = rule.actions;
    const record: AutoRunRecord = { ruleId: rule.id, rule: rule.name, done: [], refused: [] };

    if (a.warehouseId && a.warehouseId !== chosen.warehouseId) {
      const warehouseId = a.warehouseId;
      await this.attempt(record, "warehouse", async () => {
        await this.orders.changeWarehouse(ctx, orderId, warehouseId);
        return null;
      });
    }
    if (a.tagIds.length > 0) {
      const live = await withTenantTx(this.db, ctx, (tx) => this.tags.liveIn(tx, a.tagIds));
      if (live.length === 0) {
        record.refused.push({ action: "tags", code: "tag.not_found", message: "Tag di aturan ini sudah dihapus." });
      } else {
        await this.attempt(record, "tags", async () => {
          await this.tags.assign(ctx, { orderIds: [orderId], add: live.map((t) => t.id), remove: [] });
          return null;
        });
      }
    }
    // arranging accepts a new order on the way, as "Atur pengiriman" does
    const method = a.arrange;
    if (method) await this.attempt(record, "arrange", () => this.fulfillment.arrange(ctx, [orderId], method));
    else if (a.accept) await this.attempt(record, "accept", () => this.orders.accept(ctx, [orderId]));

    await withTenantTx(this.db, ctx, (tx) => this.orders.recordAutoRunIn(tx, ctx, orderId, { ...record }));
    this.log.info(
      {
        tenant_id: ctx.tenantId,
        order_id: orderId,
        rule_id: rule.id,
        done: record.done,
        refused: record.refused.map((r) => r.code),
      },
      "order processed by rule",
    );
    return record;
  }

  /**
   * One action as the buttons do it: done, or refused with the reason the button would show (a domain
   * error or a per-order result). Anything else fails the job, which BullMQ retries; the retry finds the
   * order as it now is.
   */
  private async attempt(
    record: AutoRunRecord,
    action: AutoAction,
    run: () => Promise<ActionResult[] | null>,
  ): Promise<void> {
    try {
      const result = (await run())?.[0];
      if (!result || result.ok) record.done.push(action);
      else
        record.refused.push({
          action,
          code: result.code ?? "order.refused",
          message: result.message ?? "Ditolak.",
        });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      // a refused field says more than "check the marked fields" (a warehouse deleted since)
      const message = err.errors?.[0]?.message ?? err.detail ?? err.code;
      record.refused.push({ action, code: err.code, message });
    }
  }
}
