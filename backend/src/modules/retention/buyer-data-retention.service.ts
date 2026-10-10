import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { BusinessProfileService } from "../business/business-profile.service";
import { FulfillmentService } from "../fulfillment/fulfillment.service";
import { OrdersService } from "../orders/orders.service";
import { ReturnsService } from "../returns/returns.service";
import { ANONYMIZE_BATCH, ANONYMIZE_BUDGET_MS, retentionCutoff } from "./retention-plan";

const log = logger.forModule("retention.buyer_data");

/**
 * Worker only (job `retention.buyer_anonymize`, PRD 12.1, backend doc 8.34): orders placed longer ago than the
 * business keeps buyer data lose the buyer's personal data, unless they are still held for shipping. Each
 * transaction takes one batch through the owning modules: shipments, returns, then the orders. A run stops
 * after its time budget; the next hourly scan carries on.
 */
@Injectable()
export class BuyerDataRetentionService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(BusinessProfileService) private readonly business: BusinessProfileService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(ReturnsService) private readonly returns: ReturnsService,
  ) {}

  async run(
    ctx: RequestContext,
    now = new Date(),
    budgetMs = ANONYMIZE_BUDGET_MS,
  ): Promise<{ anonymized: number; done: boolean }> {
    const months = await withTenantTx(this.db, ctx, (tx) => this.business.buyerDataRetentionIn(tx));
    const before = retentionCutoff(now, months);
    const started = Date.now();
    let anonymized = 0;
    for (;;) {
      const batch = await withTenantTx(this.db, ctx, async (tx) => {
        const ids = await this.orders.buyerDataDueIn(tx, before, ANONYMIZE_BATCH);
        if (ids.length === 0) return { found: 0, changed: 0 };
        await this.fulfillment.anonymizeIn(tx, ids);
        await this.returns.anonymizeIn(tx, ids);
        return { found: ids.length, changed: await this.orders.anonymizeBuyersIn(tx, ids, now) };
      });
      anonymized += batch.changed;
      const done = batch.found < ANONYMIZE_BATCH;
      if (done || Date.now() - started >= budgetMs) {
        if (anonymized > 0 || !done)
          log.info({ tenant_id: ctx.tenantId, months, anonymized, done }, "buyer data anonymized");
        return { anonymized, done };
      }
    }
  }
}
