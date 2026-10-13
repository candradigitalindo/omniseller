import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import { DomainError } from "../../common/errors/domain-errors";
import { hasFeature } from "../../common/plan-features";
import type { DbHandle, Tx } from "../../db/client";
import type { AutoPrintIntent } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { DevicesService } from "../identity/devices.service";
import { TenantsService } from "../identity/tenants.service";
import { actorOf, OrderIntakeService } from "../orders/order-intake.service";
import type { OrderRow } from "../orders/orders.repository";
import { OrdersService } from "../orders/orders.service";
import { FulfillmentRepository, type ShipmentRow } from "./fulfillment.repository";
import { FulfillmentService } from "./fulfillment.service";
import { PrintService } from "./print.service";
import { ScanService } from "./scan.service";
import type { Refusal } from "./shipping-plan";

/** The history entry of a rule's label print (backend doc 8.37): queued, skipped, or refused, and why. */
export const AUTO_PRINT = "auto_print";
/** Shipments printed per job run. */
const AUTO_PRINT_BATCH = 200;

type Outcome = { status: "queued"; agent: string } | { status: "skipped" | "refused"; code: string; message: string };

/**
 * FR-SHP-18 (backend doc 8.37), worker only: labels that became ready for a shipment carrying a rule's
 * print instruction are printed on the rule's agent, as the system, through the same document and print
 * job a scan to print makes. Labels ready together go in one document per agent and layout, in pick-list
 * order. A label somebody already printed, a label past the instruction's time, an agent revoked or of
 * another warehouse, and a plan without the feature are recorded in the order's history instead.
 */
@Injectable()
export class AutoPrintService {
  private readonly log = logger.forModule("fulfillment.auto_print");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(FulfillmentRepository) private readonly repo: FulfillmentRepository,
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(PrintService) private readonly print: PrintService,
    @Inject(ScanService) private readonly scan: ScanService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(OrderIntakeService) private readonly intake: OrderIntakeService,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  /** Job `shipment.auto_print`: prints every label now ready for a rule's print instruction. */
  async printDue(ctx: RequestContext, now = new Date()): Promise<{ queued: number; skipped: number; refused: number }> {
    const counts = { queued: 0, skipped: 0, refused: 0 };
    await withTenantTx(this.db, ctx, async (tx) => {
      const due = await this.repo.autoPrintDue(tx, AUTO_PRINT_BATCH);
      if (due.length === 0) return;
      const featured = hasFeature(await this.tenants.planIn(tx, ctx), "auto_process");
      const { orders } = await this.orders.readIn(
        tx,
        due.map((s) => s.orderId),
      );
      const groups = new Map<string, { intent: AutoPrintIntent; agent: string; orders: OrderRow[] }>();
      const outcomes = new Map<string, Outcome>();
      for (const s of due) {
        const intent = s.autoPrint!;
        const o = orders.find((x) => x.id === s.orderId);
        const verdict = await this.verdictIn(tx, s, o, intent, featured, now);
        if (!verdict.ok) {
          outcomes.set(s.orderId, verdict.outcome);
          continue;
        }
        const key = [intent.deviceId, intent.format, intent.template, intent.packingList].join("|");
        const group = groups.get(key) ?? { intent, agent: verdict.agent, orders: [] };
        group.orders.push(o!);
        groups.set(key, group);
      }
      for (const g of groups.values()) {
        try {
          // nested: a refusal of the whole group rolls back only its document
          await withTenantTx(this.db, ctx, async (inner) => {
            const doc = await this.fulfillment.requestDocumentIn(inner, ctx, "labels", {
              orderIds: g.orders.map((o) => o.id),
              format: g.intent.format,
              template: g.intent.template,
              packingList: g.intent.packingList,
            });
            const title =
              g.orders.length === 1
                ? `Label ${g.orders[0]!.externalOrderId} (otomatis)`
                : `Label ${g.orders.length} pesanan (otomatis)`;
            await this.print.queueIn(inner, ctx, doc, { deviceId: g.intent.deviceId }, title, "actions.print.deviceId");
          });
          for (const o of g.orders) outcomes.set(o.id, { status: "queued", agent: g.agent });
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
          const message = err.errors?.[0]?.message ?? err.detail ?? err.code;
          for (const o of g.orders) outcomes.set(o.id, { status: "refused", code: err.code, message });
        }
      }
      for (const s of due) {
        const outcome = outcomes.get(s.orderId)!;
        counts[outcome.status]++;
        await this.repo.updateShipment(tx, s.id, { autoPrint: null });
        await this.intake.recordIn(tx, ctx, s.orderId, AUTO_PRINT, actorOf(ctx), {
          ...outcome,
          ruleId: s.autoPrint!.ruleId,
        });
      }
    });
    if (counts.queued + counts.skipped + counts.refused > 0) {
      this.log.info({ tenant_id: ctx.tenantId, ...counts }, "labels auto printed");
    }
    return counts;
  }

  /** Whether this shipment's label is printed now, or why not. */
  private async verdictIn(
    tx: Tx,
    s: ShipmentRow,
    o: OrderRow | undefined,
    intent: AutoPrintIntent,
    featured: boolean,
    now: Date,
  ): Promise<{ ok: true; agent: string } | { ok: false; outcome: Outcome }> {
    const skipped = (code: string, message: string): { ok: false; outcome: Outcome } => ({
      ok: false,
      outcome: { status: "skipped", code, message },
    });
    const refused = (r: Refusal): { ok: false; outcome: Outcome } => ({
      ok: false,
      outcome: { status: "refused", ...r },
    });
    if (!o) return skipped("order.not_found", "Pesanan tidak ditemukan.");
    if (!featured) {
      return skipped("billing.feature_unavailable", "Aturan proses otomatis tidak termasuk paket yang berlaku.");
    }
    if (now.getTime() > Date.parse(intent.until)) {
      return skipped("auto_print.expired", "Label baru siap lama setelah pengiriman diatur; tidak dicetak otomatis.");
    }
    const since = s.arrangedAt ?? s.createdAt;
    if (
      (await this.orders.labelPrintedSinceIn(tx, o.id, since)) ||
      (await this.repo.labelsDocumentSince(tx, o.id, since))
    ) {
      return skipped("auto_print.already_printed", "Label pesanan ini sudah dicetak.");
    }
    const d = await this.devices.getIn(tx, intent.deviceId);
    if (d?.kind !== "print_agent" || d.revokedAt) {
      return refused({ code: "print_agent.invalid", message: "Agen cetak tidak ditemukan atau sudah dicabut." });
    }
    if (d.warehouseId && d.warehouseId !== o.warehouseId) {
      return refused({ code: "print_agent.other_warehouse", message: `Agen cetak ${d.name} melayani gudang lain.` });
    }
    const why = await this.scan.labelRefusalIn(tx, o);
    if (why) return refused(why);
    return { ok: true, agent: d.name };
  }
}
