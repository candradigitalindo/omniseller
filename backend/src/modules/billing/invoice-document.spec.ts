import { describe, expect, it } from "vitest";
import {
  type InvoiceFacts,
  type InvoiceIssuer,
  invoiceDocument,
  invoiceFileName,
  issuerParty,
  paymentMethodText,
  SYSTEM_NOTE,
} from "./invoice-document";

const issuer: InvoiceIssuer = { name: "OmniSeller", address: null, npwp: null, email: null };
const billTo = {
  name: "Toko Maju Jaya",
  address: {
    line1: "Jl. Merdeka No. 10",
    district: "Coblong",
    city: "Kota Bandung",
    province: "Jawa Barat",
    postalCode: "40132",
  },
  npwp: "012345678901000",
};
const pending: InvoiceFacts = {
  number: "INV-2610-0001",
  kind: "upgrade",
  status: "pending",
  amount: 249_000,
  creditAmount: 50_000,
  // 8 Oct 2026 07:05 WIB
  createdAt: new Date("2026-10-08T00:05:00Z"),
  periodStart: new Date("2026-10-08T00:05:00Z"),
  periodEnd: new Date("2026-11-08T00:05:00Z"),
  dueAt: new Date("2026-10-09T00:05:00Z"),
  paidAt: null,
  paidAmount: null,
  paymentMethod: null,
  paymentChannel: null,
  invoiceUrl: null,
};

describe("invoice document (backend doc 8.32)", () => {
  it("bills the plan at its price less the credit, for a month from when it is paid", () => {
    const doc = invoiceDocument({ invoice: pending, planName: "Growth", timeZone: "Asia/Jakarta", issuer, billTo });
    expect(doc).toMatchObject({ title: "TAGIHAN", number: "INV-2610-0001", statusLabel: "Menunggu pembayaran" });
    // the row's period of a move up is an estimate until it is paid (backend doc 8.32)
    expect(doc.facts).toEqual([
      { label: "Tanggal terbit", value: "8 Okt 2026" },
      { label: "Periode", value: "1 bulan sejak dibayar" },
      { label: "Jatuh tempo", value: "9 Okt 2026" },
    ]);
    expect(doc.lines).toEqual([
      {
        description: "Langganan OmniSeller paket Growth",
        detail: "Naik paket, 1 bulan sejak dibayar",
        amount: "Rp 299.000",
      },
      {
        description: "Potongan sisa paket sebelumnya",
        detail: "Sisa periode yang sudah dibayar, dihitung saat tagihan dibuat",
        amount: "-Rp 50.000",
      },
    ]);
    expect(doc.totals).toEqual([{ label: "Total", value: "Rp 249.000", strong: true }]);
    expect(doc.billTo).toEqual({
      name: "Toko Maju Jaya",
      lines: ["Jl. Merdeka No. 10", "Coblong, Kota Bandung", "Jawa Barat 40132", "NPWP 01.234.567.8-901.000"],
    });
    expect(doc.notes).toEqual(["Bayar lewat menu Langganan & Tagihan di OmniSeller.", SYSTEM_NOTE]);
  });

  it("dates a renewal by its period, and names Xendit's page once there is one", () => {
    const doc = invoiceDocument({
      invoice: {
        ...pending,
        kind: "renewal",
        creditAmount: 0,
        // 12 Oct 2026 00:00 WIB
        periodStart: new Date("2026-10-11T17:00:00Z"),
        periodEnd: new Date("2026-11-11T17:00:00Z"),
        dueAt: new Date("2026-10-11T17:00:00Z"),
        invoiceUrl: "https://checkout.xendit.co/web/6523a1b2c3d4",
      },
      planName: "Growth",
      timeZone: "Asia/Jakarta",
      issuer,
      billTo,
    });
    expect(doc.facts).toEqual([
      { label: "Tanggal terbit", value: "8 Okt 2026" },
      { label: "Periode", value: "12 Okt 2026 – 12 Nov 2026" },
      { label: "Jatuh tempo", value: "12 Okt 2026" },
    ]);
    expect(doc.lines[0]!.detail).toBe("Perpanjangan, 1 bulan: 12 Okt 2026 – 12 Nov 2026");
    expect(doc.notes[0]).toBe(
      "Bayar di https://checkout.xendit.co/web/6523a1b2c3d4 atau lewat menu Langganan & Tagihan di OmniSeller.",
    );
    // once the page is closed, the link is not printed
    const voided = invoiceDocument({
      invoice: { ...pending, status: "void", invoiceUrl: "https://checkout.xendit.co/web/6523a1b2c3d4" },
      planName: "Growth",
      timeZone: "Asia/Jakarta",
      issuer,
      billTo,
    });
    expect(voided.notes.join(" ")).not.toContain("checkout.xendit.co");
  });

  it("turns into the proof of payment once paid, with the time in the business's zone", () => {
    const doc = invoiceDocument({
      invoice: {
        ...pending,
        kind: "renewal",
        creditAmount: 0,
        amount: 299_000,
        status: "paid",
        // 8 Oct 2026 14:05 WITA
        paidAt: new Date("2026-10-08T06:05:00Z"),
        paidAmount: 299_000,
        paymentMethod: "BANK_TRANSFER",
        paymentChannel: "BCA",
      },
      planName: "Growth",
      timeZone: "Asia/Makassar",
      issuer,
      billTo: { name: "Toko Maju Jaya", address: {}, npwp: null },
    });
    expect(doc.statusLabel).toBe("Lunas");
    expect(doc.facts).toEqual([
      { label: "Tanggal terbit", value: "8 Okt 2026" },
      { label: "Periode", value: "8 Okt 2026 – 8 Nov 2026" },
      { label: "Tanggal bayar", value: "8 Okt 2026, 14.05 WITA" },
      { label: "Metode pembayaran", value: "Transfer bank BCA" },
    ]);
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({
      detail: "Perpanjangan, 1 bulan: 8 Okt 2026 – 8 Nov 2026",
      amount: "Rp 299.000",
    });
    expect(doc.totals).toEqual([
      { label: "Total", value: "Rp 299.000", strong: true },
      { label: "Dibayar", value: "Rp 299.000", strong: false },
    ]);
    expect(doc.billTo).toEqual({ name: "Toko Maju Jaya", lines: [] });
    expect(doc.notes).toEqual(["Tagihan yang lunas ini juga berlaku sebagai bukti pembayaran.", SYSTEM_NOTE]);
    // a paid move up has its real period: from the payment
    const upgrade = invoiceDocument({
      invoice: {
        ...pending,
        status: "paid",
        paidAt: new Date("2026-10-08T06:05:00Z"),
        paidAmount: 249_000,
        periodStart: new Date("2026-10-08T06:05:00Z"),
        periodEnd: new Date("2026-11-08T06:05:00Z"),
      },
      planName: "Growth",
      timeZone: "Asia/Jakarta",
      issuer,
      billTo,
    });
    expect(upgrade.facts[1]).toEqual({ label: "Periode", value: "8 Okt 2026 – 8 Nov 2026" });
    expect(upgrade.lines[0]!.detail).toBe("Naik paket, 1 bulan: 8 Okt 2026 – 8 Nov 2026");
    // what Xendit says was paid, even when it is not the amount asked
    expect(
      invoiceDocument({
        invoice: { ...pending, status: "paid", paidAt: new Date("2026-10-08T06:05:00Z"), paidAmount: 250_000 },
        planName: "Growth",
        timeZone: "Asia/Jakarta",
        issuer,
        billTo,
      }).totals,
    ).toEqual([
      { label: "Total", value: "Rp 249.000", strong: true },
      { label: "Dibayar", value: "Rp 250.000", strong: false },
    ]);
  });

  it("says why an invoice that cannot be paid is not owed, without a due date", () => {
    for (const [status, label, note] of [
      ["void", "Dibatalkan", /dibatalkan dan tidak perlu dibayar/],
      ["expired", "Kedaluwarsa", /kedaluwarsa dan tidak bisa dibayar lagi/],
    ] as const) {
      const doc = invoiceDocument({
        invoice: { ...pending, status },
        planName: "Growth",
        timeZone: "Asia/Jakarta",
        issuer,
        billTo,
      });
      expect(doc.statusLabel).toBe(label);
      expect(doc.facts.map((f) => f.label)).toEqual(["Tanggal terbit", "Periode"]);
      expect(doc.notes[0]).toMatch(note);
      expect(doc.totals).toHaveLength(1);
    }
    const failed = invoiceDocument({
      invoice: { ...pending, status: "failed" },
      planName: "Growth",
      timeZone: "Asia/Jakarta",
      issuer,
      billTo,
    });
    expect(failed.facts.map((f) => f.label)).toContain("Jatuh tempo");
    expect(failed.statusLabel).toBe("Gagal");
  });

  it("prints only the parts of the issuer that are set", () => {
    expect(issuerParty(issuer)).toEqual({ name: "OmniSeller", lines: [] });
    expect(
      issuerParty({
        name: "PT Contoh Niaga Digital",
        address: "Jl. Sudirman Kav. 1, Jakarta 10220",
        npwp: "3171234567890123",
        email: "tagihan@omniseller.id",
      }),
    ).toEqual({
      name: "PT Contoh Niaga Digital",
      lines: ["Jl. Sudirman Kav. 1, Jakarta 10220", "NPWP 3171234567890123", "Email tagihan@omniseller.id"],
    });
  });

  it("names the payment method once, whatever Xendit repeats", () => {
    expect(paymentMethodText("BANK_TRANSFER", "BCA")).toBe("Transfer bank BCA");
    expect(paymentMethodText("QR_CODE", "QRIS")).toBe("QRIS");
    expect(paymentMethodText("CREDIT_CARD", "CREDIT_CARD")).toBe("Kartu");
    expect(paymentMethodText("EWALLET", "OVO")).toBe("E-wallet OVO");
    expect(paymentMethodText("CRYPTO", null)).toBe("CRYPTO");
    expect(paymentMethodText(null, "BCA")).toBe("BCA");
    expect(paymentMethodText(null, null)).toBeNull();
  });

  it("saves the file under the invoice number", () => {
    expect(invoiceFileName("INV-2610-0001")).toBe("INV-2610-0001.pdf");
  });
});
