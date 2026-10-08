import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { ENV } from "../../config/config.module";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { BusinessProfileService } from "../business/business-profile.service";
import { TenantsService } from "../identity/tenants.service";
import { invoiceNotFound } from "./billing.errors";
import { BillingRepository } from "./billing.repository";
import { type InvoiceDocument, type InvoiceIssuer, invoiceDocument, invoiceFileName } from "./invoice-document";
import { renderInvoicePdf } from "./invoice-pdf";

/** The api's `BILLING_ISSUER_*` env: who issues the invoices. */
export interface IssuerEnv {
  BILLING_ISSUER_NAME: string;
  BILLING_ISSUER_ADDRESS?: string | undefined;
  BILLING_ISSUER_NPWP?: string | undefined;
  BILLING_ISSUER_EMAIL?: string | undefined;
}

/**
 * An invoice as PDF (backend doc 8.32, UI L45), api only: read in one transaction and drawn after it. A
 * paid invoice is billed to the copy of the business profile kept when it was paid (`bill_to`); any other
 * invoice, or one paid before copies were kept, to the profile as it is now.
 */
@Injectable()
export class InvoicePdfService {
  private readonly issuer: InvoiceIssuer;

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(BillingRepository) private readonly repo: BillingRepository,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(BusinessProfileService) private readonly business: BusinessProfileService,
    @Inject(ENV) env: IssuerEnv,
  ) {
    this.issuer = {
      name: env.BILLING_ISSUER_NAME,
      address: env.BILLING_ISSUER_ADDRESS ?? null,
      npwp: env.BILLING_ISSUER_NPWP ?? null,
      email: env.BILLING_ISSUER_EMAIL ?? null,
    };
  }

  /** What the invoice's PDF says; 404 `invoice.not_found` outside the caller's business. */
  document(ctx: RequestContext, id: string): Promise<InvoiceDocument> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const inv = await this.repo.invoice(tx, id);
      if (!inv) throw invoiceNotFound();
      const planName = (await this.tenants.planNamesIn(tx)).get(inv.planId) ?? "";
      const { timezone } = await this.tenants.profileIn(tx, ctx);
      const billTo = inv.billTo ?? (await this.business.billToIn(tx, ctx));
      return invoiceDocument({ invoice: inv, planName, timeZone: timezone, issuer: this.issuer, billTo });
    });
  }

  async render(ctx: RequestContext, id: string): Promise<{ fileName: string; pdf: Uint8Array }> {
    const doc = await this.document(ctx, id);
    return { fileName: invoiceFileName(doc.number), pdf: await renderInvoicePdf(doc) };
  }
}
