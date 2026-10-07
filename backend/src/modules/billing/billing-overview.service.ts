import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { ENV } from "../../config/config.module";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { isManualChannel, StoresService } from "../channel/stores.service";
import { UsersService } from "../identity/users.service";
import { WarehousesService } from "../inventory/warehouses.service";
import type { InvoiceRow } from "./billing.repository";
import { BillingService, type BillingState } from "./billing.service";
import { UsageMeterService, type UsageView } from "./usage-meter.service";

export interface UsageCount {
  value: number;
  limit: number | null;
}

export interface BillingOverview extends BillingState {
  usage: { orders: UsageView; stores: UsageCount; warehouses: UsageCount; users: UsageCount };
  invoices: InvoiceRow[];
}

/**
 * L45 as the api assembles it: the subscription, the plans on offer, this month's usage against the
 * quotas, and the invoices. Counts come from the modules that own the rows; this service is api only,
 * so it may import them without a cycle (backend doc 8.32).
 */
@Injectable()
export class BillingOverviewService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(UsageMeterService) private readonly usage: UsageMeterService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(ENV) private readonly env: { BILLING_PAYMENTS: "xendit" | "off" },
  ) {}

  get paymentsAvailable(): boolean {
    return this.env.BILLING_PAYMENTS === "xendit";
  }

  async overview(ctx: RequestContext, now = new Date()): Promise<BillingOverview> {
    // marketplace stores still connected count towards the plan; manual sales channels never do
    const stores = (await this.stores.list(ctx)).filter(
      (v) => !isManualChannel(v.store.channel) && v.store.status !== "disconnected",
    ).length;
    return withTenantTx(this.db, ctx, async (tx) => {
      const state = await this.billing.stateIn(tx, ctx, this.paymentsAvailable);
      const limits = state.subscription.plan.limits;
      const warehouses = (await this.warehouses.visibleIn(tx, { ...ctx, warehouseScope: null })).length;
      return {
        ...state,
        usage: {
          orders: await this.usage.usageIn(tx, ctx, "orders", now),
          stores: { value: stores, limit: limits.stores ?? null },
          warehouses: { value: warehouses, limit: limits.warehouses ?? null },
          users: { value: await this.users.countSeatsIn(tx), limit: limits.users ?? null },
        },
        invoices: await this.billing.invoicesIn(tx),
      };
    });
  }
}
