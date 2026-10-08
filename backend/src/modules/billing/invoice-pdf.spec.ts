import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { type InvoiceFacts, invoiceDocument } from "./invoice-document";
import { renderInvoicePdf } from "./invoice-pdf";

const facts: InvoiceFacts = {
  number: "INV-2610-0007",
  kind: "renewal",
  status: "paid",
  amount: 299_000,
  creditAmount: 0,
  createdAt: new Date("2026-10-01T03:00:00Z"),
  periodStart: new Date("2026-10-08T00:00:00Z"),
  periodEnd: new Date("2026-11-08T00:00:00Z"),
  dueAt: new Date("2026-10-08T00:00:00Z"),
  paidAt: new Date("2026-10-02T04:30:00Z"),
  paidAmount: 299_000,
  paymentMethod: "EWALLET",
  paymentChannel: "OVO",
  invoiceUrl: null,
};

describe("invoice PDF (backend doc 8.32)", () => {
  it("draws one A4 page titled with the invoice number", async () => {
    const pdf = await renderInvoicePdf(
      invoiceDocument({
        invoice: facts,
        planName: "Growth",
        timeZone: "Asia/Jakarta",
        issuer: { name: "OmniSeller", address: "Jl. Sudirman Kav. 1, Jakarta 10220", npwp: null, email: null },
        billTo: { name: "Toko Maju Jaya", address: { city: "Kota Bandung" }, npwp: "012345678901000" },
      }),
    );
    expect(Buffer.from(pdf.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    const size = doc.getPage(0).getSize();
    expect(Math.round(size.width)).toBe(595);
    expect(Math.round(size.height)).toBe(842);
    expect(doc.getTitle()).toBe("Tagihan INV-2610-0007");
  });

  it("keeps long names, emoji, and every status on the one page", async () => {
    const long = "Toko Serba Ada Sejahtera Bersama Abadi Selamanya 🛍️ ".repeat(6);
    for (const status of ["pending", "paid", "expired", "failed", "void"] as const) {
      const pdf = await renderInvoicePdf(
        invoiceDocument({
          invoice: { ...facts, status, creditAmount: 120_000, amount: 179_000, kind: "upgrade" },
          planName: long,
          timeZone: "Asia/Jayapura",
          issuer: { name: long, address: long, npwp: "3171234567890123", email: "tagihan@omniseller.id" },
          billTo: {
            name: long,
            address: { line1: long, district: long, city: long, province: long, postalCode: "40132" },
            npwp: "3171234567890123",
          },
        }),
      );
      expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    }
  });
});
