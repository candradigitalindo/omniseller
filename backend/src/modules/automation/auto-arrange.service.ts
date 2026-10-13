import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import { hasFeature } from "../../common/plan-features";
import type { DbHandle } from "../../db/client";
import type { AutoPrintIntent } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { FulfillmentService } from "../fulfillment/fulfillment.service";
import { ARRANGEABLE } from "../fulfillment/shipping-plan";
import { TenantsService } from "../identity/tenants.service";
import { OrdersService, orderStatusLabel } from "../orders/orders.service";
import { OrderRulesService } from "./order-rules.service";
import { SCHEDULE_MAX_ATTEMPTS, ScheduleRepository, type ScheduleRow } from "./schedule.repository";

/** The history entry of a rule's timed arrange (backend doc 8.37): arranged, skipped, or refused, and why. */
export const AUTO_ARRANGE = "auto_arrange";
/** Rows claimed and arranged per transaction: a failure costs at most this many a retry. */
const ARRANGE_BATCH = 100;

type Outcome = { status: "arranged" } | { status: "skipped" | "refused"; code: string; message: string };

/**
 * The timed part of automatic rules (backend doc 8.37), worker only: orders whose rule arranges the
 * shipment at a time of day are arranged when it comes, through `FulfillmentService.arrange` like the
 * button (one marketplace request per store). A rule switched off or deleted since, a plan without the
 * feature, an order someone arranged or cancelled meanwhile: the order is left as it is and told why.
 */
@Injectable()
export class AutoArrangeService {
  private readonly log = logger.forModule("automation.arrange");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ScheduleRepository) private readonly schedules: ScheduleRepository,
    @Inject(OrderRulesService) private readonly rules: OrderRulesService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
  ) {}

  /** Job `order.auto_arrange`: arranges every order whose time came by `until`, batch by batch. */
  async arrangeDue(
    ctx: RequestContext,
    until: Date,
    now = new Date(),
  ): Promise<{ arranged: number; skipped: number; refused: number }> {
    const counts = { arranged: 0, skipped: 0, refused: 0 };
    for (let round = 0; round < 50; round++) {
      // the claim commits first: a batch that fails stays claimed until its lease ends, then is tried again
      const claimed = await withTenantTx(this.db, ctx, (tx) => this.schedules.claimDue(tx, until, now, ARRANGE_BATCH));
      if (claimed.length === 0) break;
      const batch = await withTenantTx(this.db, ctx, async (tx) => {
        const outcomes = await this.arrangeBatchIn(ctx, claimed);
        for (const row of claimed) {
          const outcome = outcomes.get(row.orderId)!;
          counts[outcome.status]++;
          await this.orders.recordAutoRunIn(
            tx,
            ctx,
            row.orderId,
            { ...outcome, method: row.method, ruleId: row.ruleId },
            AUTO_ARRANGE,
          );
        }
        await this.schedules.remove(
          tx,
          claimed.map((r) => r.id),
        );
        return claimed.length;
      });
      if (batch < ARRANGE_BATCH) break;
    }
    if (counts.arranged + counts.skipped + counts.refused > 0) {
      this.log.info({ tenant_id: ctx.tenantId, ...counts }, "scheduled shipments arranged");
    }
    return counts;
  }

  /** What becomes of each claimed row: arranged through the button's service, or left with the reason. */
  private async arrangeBatchIn(ctx: RequestContext, claimed: ScheduleRow[]): Promise<Map<string, Outcome>> {
    const outcomes = new Map<string, Outcome>();
    const skip = (orderId: string, code: string, message: string) =>
      outcomes.set(orderId, { status: "skipped", code, message });
    const featured = await withTenantTx(this.db, ctx, async (tx) =>
      hasFeature(await this.tenants.planIn(tx, ctx), "auto_process"),
    );
    const rules = new Map((await withTenantTx(this.db, ctx, (tx) => this.rules.allIn(tx))).map((r) => [r.id, r]));
    const orderIds = claimed.map((r) => r.orderId);
    const orders = await withTenantTx(this.db, ctx, async (tx) => (await this.orders.readIn(tx, orderIds)).orders);
    const live = new Map(
      (await this.fulfillment.shipmentsOf(ctx, orderIds))
        .filter((v) => v.shipment.status !== "cancelled")
        .map((v) => [v.shipment.orderId, v.shipment]),
    );
    const groups = new Map<string, { method: "pickup" | "dropoff"; print: AutoPrintIntent | null; ids: string[] }>();
    for (const row of claimed) {
      const o = orders.find((x) => x.id === row.orderId);
      const rule = row.ruleId ? rules.get(row.ruleId) : undefined;
      const shipment = live.get(row.orderId);
      if (row.attempts > SCHEDULE_MAX_ATTEMPTS) {
        outcomes.set(row.orderId, {
          status: "refused",
          code: "auto_arrange.failed",
          message: "Atur kirim otomatis gagal berulang kali; atur pengirimannya sendiri.",
        });
      } else if (!o) skip(row.orderId, "order.not_found", "Pesanan tidak ditemukan.");
      else if (shipment) {
        // somebody arranged it before the time: theirs stands, including their failed attempt
        skip(
          row.orderId,
          shipment.status === "pending" ? "shipment.in_progress" : "shipment.already_arranged",
          "Pengiriman pesanan ini sudah diatur sebelum jamnya.",
        );
      } else if (!ARRANGEABLE.has(o.status)) {
        skip(row.orderId, "order.status_invalid", `Pesanan berstatus ${orderStatusLabel(o.status)}.`);
      } else if (!featured) {
        skip(row.orderId, "billing.feature_unavailable", "Aturan proses otomatis tidak termasuk paket yang berlaku.");
      } else if (!rule) skip(row.orderId, "auto_arrange.rule_deleted", "Aturan otomatisnya sudah dihapus.");
      else if (!rule.active) skip(row.orderId, "auto_arrange.rule_inactive", "Aturan otomatisnya dimatikan.");
      else {
        const key = `${row.method}|${JSON.stringify(row.print ?? null)}`;
        const group = groups.get(key) ?? { method: row.method, print: row.print ?? null, ids: [] };
        group.ids.push(row.orderId);
        groups.set(key, group);
      }
    }
    for (const g of groups.values()) {
      const results = await this.fulfillment.arrange(ctx, g.ids, g.method, { autoPrint: g.print });
      for (const r of results) {
        outcomes.set(
          r.id,
          r.ok
            ? { status: "arranged" }
            : { status: "refused", code: r.code ?? "order.refused", message: r.message ?? "Ditolak." },
        );
      }
    }
    return outcomes;
  }
}
