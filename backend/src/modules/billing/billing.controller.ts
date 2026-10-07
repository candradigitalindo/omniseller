import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { TenantsService } from "../identity/tenants.service";
import { BillingService } from "./billing.service";
import { BillingOverviewService } from "./billing-overview.service";
import {
  BillingStateDto,
  billingStateDto,
  ChangePlanDto,
  InvoiceDto,
  InvoiceIdParamDto,
  InvoiceListDto,
  invoiceDto,
} from "./dto";

/** Langganan & Tagihan (UI L45, PRD 15.1, backend doc 8.32): the Owner's (settings:billing). */
@ApiTags("billing")
@Controller("v1/billing")
@RequirePermission("settings:billing")
export class BillingController {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(BillingOverviewService) private readonly overview: BillingOverviewService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  @Get("subscription")
  @Isolation("self")
  @ZodResponse({ type: BillingStateDto })
  async subscription(@Ctx() ctx: RequestContext) {
    return billingStateDto(await this.overview.overview(ctx));
  }

  /** Choose a plan: Starter at once or at the period's end, a paid plan through an invoice to pay. */
  @Post("subscription")
  @Isolation("self")
  @ZodResponse({ status: 200, type: BillingStateDto })
  async changePlan(@Ctx() ctx: RequestContext, @Body() body: ChangePlanDto) {
    await this.billing.changePlan(ctx, body.planCode, this.overview.paymentsAvailable);
    return billingStateDto(await this.overview.overview(ctx));
  }

  @Get("invoices")
  @Isolation({ fixture: "invoice" })
  @ZodResponse({ type: InvoiceListDto })
  async invoices(@Ctx() ctx: RequestContext) {
    return withTenantTx(this.db, ctx, async (tx) => {
      const plans = await this.tenants.listPlansIn(tx);
      return { items: (await this.billing.invoicesIn(tx)).map((i) => invoiceDto(i, plans)), next_cursor: null };
    });
  }

  @Get("invoices/:id")
  @Isolation({ fixture: "invoice" })
  @ZodResponse({ type: InvoiceDto })
  async invoice(@Ctx() ctx: RequestContext, @Param() p: InvoiceIdParamDto) {
    const inv = await this.billing.invoice(ctx, p.id);
    return invoiceDto(inv, await withTenantTx(this.db, ctx, (tx) => this.tenants.listPlansIn(tx)));
  }

  /** A waiting invoice the business no longer wants (not a renewal: downgrade for that). */
  @Post("invoices/:id/void")
  @Isolation({ fixture: "invoice" })
  @ZodResponse({ status: 200, type: InvoiceDto })
  async voidInvoice(@Ctx() ctx: RequestContext, @Param() p: InvoiceIdParamDto) {
    const inv = await this.billing.voidInvoice(ctx, p.id);
    return invoiceDto(inv, await withTenantTx(this.db, ctx, (tx) => this.tenants.listPlansIn(tx)));
  }
}
