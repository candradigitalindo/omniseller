import { describe, expect, it, vi } from "vitest";
import { EmailAttachments } from "../notification/email-attachments";
import { invoiceNotFound } from "./billing.errors";
import type { InvoicePdfService } from "./invoice-pdf.service";
import { ReceiptAttachments } from "./receipt-attachments";

const ctx = {} as never;
const pdf = new Uint8Array([37, 80, 68, 70, 45]);

function receipts(render: InvoicePdfService["render"]) {
  const files = new EmailAttachments();
  const r = new ReceiptAttachments(files, { render } as InvoicePdfService);
  r.onModuleInit();
  return files;
}

describe("receipt attachments (backend doc 8.32)", () => {
  it("attaches the invoice as PDF to the emails that say money came for it", async () => {
    const render = vi.fn(async () => ({ fileName: "INV-2610-0001.pdf", pdf }));
    const files = receipts(render);
    for (const reason of ["paid", "late_payment"]) {
      expect(
        await files.for(ctx, { kind: "billing.reminder", userId: null, data: { reason, invoiceId: "01INV" } }),
      ).toEqual([{ filename: "INV-2610-0001.pdf", contentType: "application/pdf", content: pdf }]);
    }
    expect(render).toHaveBeenCalledWith(ctx, "01INV");
    // other billing notices, other kinds, or no invoice: nothing drawn
    expect(
      await files.for(ctx, {
        kind: "billing.reminder",
        userId: null,
        data: { reason: "invoice_due", invoiceId: "01INV" },
      }),
    ).toEqual([]);
    expect(
      await files.for(ctx, { kind: "legal.reminder", userId: null, data: { reason: "paid", invoiceId: "01INV" } }),
    ).toEqual([]);
    expect(await files.for(ctx, { kind: "billing.reminder", userId: null, data: { reason: "paid" } })).toEqual([]);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("sends the email without it when the invoice is gone, and retries on any other failure", async () => {
    const gone = receipts(async () => {
      throw invoiceNotFound();
    });
    expect(
      await gone.for(ctx, { kind: "billing.reminder", userId: null, data: { reason: "paid", invoiceId: "01INV" } }),
    ).toEqual([]);
    const down = receipts(async () => {
      throw new Error("connection terminated");
    });
    await expect(
      down.for(ctx, { kind: "billing.reminder", userId: null, data: { reason: "paid", invoiceId: "01INV" } }),
    ).rejects.toThrow("connection terminated");
  });
});
