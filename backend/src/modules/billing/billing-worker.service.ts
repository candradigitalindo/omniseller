import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import { ENV } from "../../config/config.module";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { TenantsService } from "../identity/tenants.service";
import { UsersService } from "../identity/users.service";
import { XenditRefusedError } from "./billing.errors";
import { BillingRepository } from "./billing.repository";
import { BillingService, dateInZone } from "./billing.service";
import { XenditClient } from "./xendit.client";

/** The Xendit client of the worker process, built from its environment. */
export const XENDIT = Symbol("XENDIT");

/**
 * Worker side of billing (backend doc 8.32): the payment page of an invoice, asked from Xendit after the
 * invoice row exists (job `billing.invoice_create`), and closing the page of an invoice withdrawn since
 * (job `billing.invoice_expire`). Everything else about invoices is decided in `BillingService`, inside
 * transactions; Xendit is never called while one is open.
 */
@Injectable()
export class BillingWorkerService {
  private readonly log = logger.forModule("billing");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(BillingRepository) private readonly repo: BillingRepository,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(XENDIT) private readonly xendit: XenditClient,
    @Inject(ENV) private readonly env: { PUBLIC_WEB_URL: string },
  ) {}

  async createXenditInvoice(ctx: RequestContext, invoiceId: string, now = new Date()): Promise<"created" | "skipped"> {
    const prepared = await withTenantTx(this.db, ctx, async (tx) => {
      const inv = await this.repo.invoice(tx, invoiceId);
      if (inv?.status !== "pending" || inv.externalInvoiceId) return null;
      const plan = (await this.tenants.listPlansIn(tx)).find((p) => p.id === inv.planId);
      const { timezone } = await this.tenants.profileIn(tx, ctx);
      const contact = await this.users.billingContactIn(tx);
      return { inv, plan, timezone, contact };
    });
    if (!prepared) return "skipped";
    const { inv, plan, timezone, contact } = prepared;
    if (!this.xendit.configured) {
      await this.billing.markInvoiceFailed(ctx, inv.id, "Pembayaran belum dikonfigurasi di lingkungan ini.");
      return "skipped";
    }
    if (!contact) {
      await this.billing.markInvoiceFailed(
        ctx,
        inv.id,
        "Tidak ada pengguna aktif dengan izin tagihan untuk dikirimi tagihan.",
      );
      return "skipped";
    }
    const period = `${dateInZone(timezone, inv.periodStart)} sampai ${dateInZone(timezone, inv.periodEnd)}`;
    const expiresAt = inv.invoiceExpiresAt ?? inv.dueAt;
    const credit =
      inv.creditAmount > 0
        ? `, dikurangi sisa paket sebelumnya Rp ${new Intl.NumberFormat("id-ID").format(inv.creditAmount)}`
        : "";
    try {
      const created = await this.xendit.createInvoice({
        externalId: inv.id,
        amount: inv.amount,
        payerEmail: contact.email,
        payerName: contact.name,
        description:
          inv.kind === "upgrade"
            ? `Langganan OmniSeller paket ${plan?.name ?? ""}, satu bulan sejak dibayar${credit}`
            : `Langganan OmniSeller paket ${plan?.name ?? ""}, ${period}`,
        durationSeconds: Math.max(600, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
        successRedirectUrl: `${this.env.PUBLIC_WEB_URL}/langganan?bayar=sukses`,
        failureRedirectUrl: `${this.env.PUBLIC_WEB_URL}/langganan?bayar=gagal`,
        // one line at the price to pay: Xendit takes no negative lines, and the credit is in the description
        items: [{ name: `Paket ${plan?.name ?? ""} (1 bulan)`, quantity: 1, price: inv.amount }],
        metadata: { tenant_id: ctx.tenantId, invoice_id: inv.id, invoice_number: inv.number },
      });
      await this.billing.markInvoiceCreated(ctx, inv.id, created);
      this.log.info(
        { tenant_id: ctx.tenantId, invoice_id: inv.id, xendit_invoice_id: created.id },
        "xendit invoice created",
      );
      return "created";
    } catch (err) {
      // Xendit refused the request itself: asking again would be refused again (the renewal job retries later)
      if (err instanceof XenditRefusedError && err.permanent) {
        await this.billing.markInvoiceFailed(ctx, inv.id, err.detail ?? "Xendit menolak tagihan ini.");
        return "skipped";
      }
      throw err;
    }
  }

  /** Closes the Xendit page of an invoice withdrawn here, so it takes no more money. */
  async expireXenditInvoice(ctx: RequestContext, invoiceId: string): Promise<"expired" | "skipped"> {
    const inv = await withTenantTx(this.db, ctx, (tx) => this.repo.invoice(tx, invoiceId));
    if (!inv?.externalInvoiceId || (inv.status !== "void" && inv.status !== "expired")) return "skipped";
    try {
      await this.xendit.expireInvoice(inv.externalInvoiceId);
      this.log.info({ tenant_id: ctx.tenantId, invoice_id: inv.id }, "xendit invoice expired");
      return "expired";
    } catch (err) {
      // already paid, expired, or unknown at Xendit: nothing left to close (a payment arrives as a callback)
      if (err instanceof XenditRefusedError && err.permanent) {
        this.log.warn(
          { tenant_id: ctx.tenantId, invoice_id: inv.id, error_code: err.errorCode },
          "xendit kept the invoice",
        );
        return "skipped";
      }
      throw err;
    }
  }
}
