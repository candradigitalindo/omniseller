import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { NotFoundError } from "../../common/errors/domain-errors";
import type { EmailAttachment } from "../notification/email";
import { type AttachingNotification, EmailAttachments } from "../notification/email-attachments";
import { InvoicePdfService } from "./invoice-pdf.service";

/** The `billing.reminder` reasons that mean money came for an invoice: their email carries it as PDF. */
const RECEIPT_REASONS = new Set(["paid", "late_payment"]);

/**
 * Worker only (backend doc 8.32): the invoice as PDF with the email of "Pembayaran ... diterima", drawn
 * when the email goes out (job `notification.email`). Registered with the notification module's
 * `EmailAttachments`, which knows nothing of billing.
 */
@Injectable()
export class ReceiptAttachments implements OnModuleInit {
  constructor(
    @Inject(EmailAttachments) private readonly attachments: EmailAttachments,
    @Inject(InvoicePdfService) private readonly pdfs: InvoicePdfService,
  ) {}

  onModuleInit(): void {
    this.attachments.register((ctx, n) => this.for(ctx, n));
  }

  async for(ctx: RequestContext, n: AttachingNotification): Promise<EmailAttachment[]> {
    const id = n.data.invoiceId;
    if (n.kind !== "billing.reminder" || !RECEIPT_REASONS.has(String(n.data.reason)) || typeof id !== "string") {
      return [];
    }
    try {
      const { fileName, pdf } = await this.pdfs.render(ctx, id);
      return [{ filename: fileName, contentType: "application/pdf", content: pdf }];
    } catch (err) {
      // an invoice that is not there (never expected) leaves the email without it rather than unsent
      if (err instanceof NotFoundError) return [];
      throw err;
    }
  }
}
