import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { DomainError } from "../../common/errors/domain-errors";
import { hasFeature } from "../../common/plan-features";
import type { DbHandle, Tx } from "../../db/client";
import type { AutoPrintIntent, OrderRulePrint } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { CourierCalendarService } from "../campaign/courier-calendar.service";
import { FulfillmentService } from "../fulfillment/fulfillment.service";
import { DevicesService } from "../identity/devices.service";
import { TenantsService } from "../identity/tenants.service";
import type { OrderRow } from "../orders/orders.repository";
import { type ActionResult, OrdersService } from "../orders/orders.service";
import { TagsService } from "../orders/tags.service";
import {
  type AutoAction,
  type AutoRunRecord,
  firstMatch,
  needsHours,
  type OrderFacts,
  openAt,
  printIntent,
  scheduledArrange,
} from "./automation-plan";
import { OrderRulesService } from "./order-rules.service";
import { ScheduleRepository } from "./schedule.repository";

/** The earlier of two deadlines; null when neither is known. */
function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

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
 * into the order's history. Nothing runs while the plan lacks `auto_process`. A rule with a time of day
 * accepts the order now and leaves the arrange to `AutoArrangeService`; a rule that prints hands the
 * shipment its print instruction (`AutoPrintService`).
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
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(ScheduleRepository) private readonly schedules: ScheduleRepository,
  ) {}

  /**
   * Runs the first matching rule on the order; null when none acted. `now` decides operating hours and
   * the time of a timed arrange. Everything happens in one transaction: the services the actions call
   * nest in it as savepoints, so a refusal rolls back only its step, and anything else rolls back the
   * whole run for BullMQ's retry, which finds the order as it was.
   */
  async run(ctx: RequestContext, orderId: string, now = new Date()): Promise<AutoRunRecord | null> {
    const record = await withTenantTx(this.db, ctx, async (tx): Promise<AutoRunRecord | null> => {
      // a duplicate delivery of the job waits here, on this transaction's own connection, and then
      // finds the order processed
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`order.auto_process|${orderId}`}))`);
      const rules = await this.rules.activeIn(tx);
      if (rules.length === 0) return null;
      // rules wait while the plan lacks the feature, and run again after a move up
      if (!hasFeature(await this.tenants.planIn(tx, ctx), "auto_process")) return null;
      const candidate = await this.orders.autoCandidateIn(tx, orderId);
      if (!candidate) return null;
      const timed = rules.some((r) => r.actions.arrangeAt !== null);
      const hours = needsHours(rules) || timed ? await this.calendar.businessHoursIn(tx, ctx) : null;
      const open = needsHours(rules) ? openAt(hours, now) : true;
      const rule = firstMatch(rules, factsOf(candidate.order, candidate.lines), open);
      if (!rule) return null;
      const a = rule.actions;
      const record: AutoRunRecord = { ruleId: rule.id, rule: rule.name, done: [], refused: [] };

      if (a.warehouseId && a.warehouseId !== candidate.order.warehouseId) {
        const warehouseId = a.warehouseId;
        await this.attempt(record, "warehouse", async () => {
          await this.orders.changeWarehouse(ctx, orderId, warehouseId);
          return null;
        });
      }
      if (a.tagIds.length > 0) {
        const live = await this.tags.liveIn(tx, a.tagIds);
        if (live.length === 0) {
          record.refused.push({ action: "tags", code: "tag.not_found", message: "Tag di aturan ini sudah dihapus." });
        } else {
          await this.attempt(record, "tags", async () => {
            await this.tags.assign(ctx, { orderIds: [orderId], add: live.map((t) => t.id), remove: [] });
            return null;
          });
        }
      }
      const method = a.arrange;
      if (method) {
        // the order as it is now: the warehouse step may have moved it, and its deadline with it
        const [order] = (await this.orders.readIn(tx, [orderId])).orders;
        const autoPrint = a.print ? await this.printIntentIn(tx, record, a.print, order!, rule.id, now) : null;
        const schedule = a.arrangeAt
          ? scheduledArrange({
              time: a.arrangeAt,
              timezone: (await this.tenants.profileIn(tx, ctx)).timezone,
              hours: hours ? { week: hours.week, periods: hours.periods } : null,
              now,
              deadline: earliest(order!.shipByAt, order!.internalShipByAt),
            })
          : null;
        if (schedule && "at" in schedule) {
          // accepted now, so the team can pack; the arrange request waits for the time
          await this.attempt(record, "accept", () => this.orders.accept(ctx, [orderId]));
          if (record.done.includes("accept")) {
            await this.schedules.insert(tx, {
              id: newId(),
              tenantId: ctx.tenantId,
              orderId,
              ruleId: rule.id,
              method,
              dueAt: schedule.at,
              print: autoPrint,
            });
            record.done.push("schedule");
            record.arrangeAt = schedule.at.toISOString();
            if (autoPrint) record.done.push("print");
          }
        } else {
          if (schedule) record.arrangeNow = schedule.now;
          // arranging accepts a new order on the way, as "Atur pengiriman" does
          await this.attempt(record, "arrange", () => this.fulfillment.arrange(ctx, [orderId], method, { autoPrint }));
          if (autoPrint && record.done.includes("arrange")) record.done.push("print");
        }
      } else if (a.accept) await this.attempt(record, "accept", () => this.orders.accept(ctx, [orderId]));

      await this.orders.recordAutoRunIn(tx, ctx, orderId, { ...record });
      return record;
    });
    if (!record) return null;
    this.log.info(
      {
        tenant_id: ctx.tenantId,
        order_id: orderId,
        rule_id: record.ruleId,
        done: record.done,
        refused: record.refused.map((r) => r.code),
      },
      "order processed by rule",
    );
    return record;
  }

  /**
   * The rule's print instruction for this order, checked now so a revoked agent or one of another
   * warehouse is refused at once; the label itself is printed when it is ready (FR-SHP-18).
   */
  private async printIntentIn(
    tx: Tx,
    record: AutoRunRecord,
    print: Required<OrderRulePrint>,
    order: OrderRow,
    ruleId: string,
    now: Date,
  ): Promise<AutoPrintIntent | null> {
    const refuse = (code: string, message: string) => {
      record.refused.push({ action: "print", code, message });
      return null;
    };
    const d = await this.devices.getIn(tx, print.deviceId);
    if (d?.kind !== "print_agent" || d.revokedAt) {
      return refuse("print_agent.invalid", "Agen cetak tidak ditemukan atau sudah dicabut.");
    }
    if (d.warehouseId && d.warehouseId !== order.warehouseId) {
      return refuse("print_agent.other_warehouse", `Agen cetak ${d.name} melayani gudang lain.`);
    }
    return printIntent(print, ruleId, now);
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
