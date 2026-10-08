import { formatRupiah } from "@omniseller/shared";
import type { InvoiceBillTo } from "../../db/schema";
import { addressLines, formatNpwp } from "../business/business-plan";
import type { InvoiceRow } from "./billing.repository";

/**
 * What an invoice's PDF says (backend doc 8.32, UI L45), as text ready to draw: who issues it, who it is
 * billed to, the plan at the price of its period less the credit, and how it was paid. Dates are in the
 * business's time zone. Pure; `invoice-pdf.ts` draws it.
 */

/** Who issues invoices: the api's `BILLING_ISSUER_*` env. Parts left out are not printed. */
export interface InvoiceIssuer {
  name: string;
  address: string | null;
  /** Digits. */
  npwp: string | null;
  email: string | null;
}

export interface InvoiceParty {
  name: string;
  /** The address, then the NPWP and the email when known. */
  lines: string[];
}

export interface InvoiceDocument {
  title: string;
  number: string;
  status: InvoiceRow["status"];
  statusLabel: string;
  /** Under the title: dates, the period, how it was paid. */
  facts: { label: string; value: string }[];
  issuer: InvoiceParty;
  billTo: InvoiceParty;
  lines: { description: string; detail: string; amount: string }[];
  totals: { label: string; value: string; strong: boolean }[];
  notes: string[];
}

export type InvoiceFacts = Pick<
  InvoiceRow,
  | "number"
  | "kind"
  | "status"
  | "amount"
  | "creditAmount"
  | "periodStart"
  | "periodEnd"
  | "dueAt"
  | "createdAt"
  | "paidAt"
  | "paidAmount"
  | "paymentMethod"
  | "paymentChannel"
  | "invoiceUrl"
>;

const STATUS_LABEL: Record<InvoiceRow["status"], string> = {
  pending: "Menunggu pembayaran",
  paid: "Lunas",
  expired: "Kedaluwarsa",
  failed: "Gagal",
  void: "Dibatalkan",
};

/** Xendit's payment method codes as the screen names them (`billing.method_*`); others as Xendit sent them. */
const METHOD_LABEL: Record<string, string> = {
  BANK_TRANSFER: "Transfer bank",
  EWALLET: "E-wallet",
  QR_CODE: "QRIS",
  CREDIT_CARD: "Kartu",
  RETAIL_OUTLET: "Gerai ritel",
  DIRECT_DEBIT: "Debit langsung",
  PAYLATER: "Paylater",
};

const STATUS_NOTE: Partial<Record<InvoiceRow["status"], string>> = {
  pending: "Bayar lewat menu Langganan & Tagihan di OmniSeller.",
  paid: "Tagihan yang lunas ini juga berlaku sebagai bukti pembayaran.",
  expired: "Tagihan ini kedaluwarsa dan tidak bisa dibayar lagi.",
  failed: "Halaman pembayaran tagihan ini belum berhasil dibuat, jadi tagihan ini belum bisa dibayar.",
  void: "Tagihan ini dibatalkan dan tidak perlu dibayar.",
};

export const SYSTEM_NOTE = "Dokumen ini dibuat secara elektronik oleh OmniSeller.";

/** "8 Okt 2026" in the business's time zone. */
export function documentDate(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone }).format(at);
}

/** "8 Okt 2026, 14.05 WIB" in the business's time zone. */
export function documentDateTime(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(at);
}

/** How the money came: "Transfer bank BCA", "QRIS"; null when Xendit named neither. */
export function paymentMethodText(method: string | null, channel: string | null): string | null {
  const name = method ? (METHOD_LABEL[method] ?? method) : null;
  const same = (a: string | null, b: string | null) => !!a && !!b && a.toUpperCase() === b.toUpperCase();
  const extra = channel && !same(channel, method) && !same(channel, name) ? channel : null;
  return [name, extra].filter(Boolean).join(" ") || null;
}

export function issuerParty(issuer: InvoiceIssuer): InvoiceParty {
  return {
    name: issuer.name,
    lines: [
      issuer.address,
      issuer.npwp ? `NPWP ${formatNpwp(issuer.npwp)}` : null,
      issuer.email ? `Email ${issuer.email}` : null,
    ].filter((l): l is string => !!l),
  };
}

export function billToParty(billTo: InvoiceBillTo): InvoiceParty {
  return {
    name: billTo.name,
    lines: [...addressLines(billTo.address), ...(billTo.npwp ? [`NPWP ${formatNpwp(billTo.npwp)}`] : [])],
  };
}

export function invoiceDocument(input: {
  invoice: InvoiceFacts;
  planName: string;
  timeZone: string;
  issuer: InvoiceIssuer;
  billTo: InvoiceBillTo;
}): InvoiceDocument {
  const { invoice: inv, timeZone } = input;
  const date = (at: Date) => documentDate(timeZone, at);
  const paid = inv.status === "paid" && inv.paidAt !== null;
  // a move up runs for a month from its payment: until then its dates are only an estimate
  const dated = inv.kind === "renewal" || paid;
  const period = dated ? `${date(inv.periodStart)} – ${date(inv.periodEnd)}` : "1 bulan sejak dibayar";
  const via = paid ? paymentMethodText(inv.paymentMethod, inv.paymentChannel) : null;

  const facts = [
    { label: "Tanggal terbit", value: date(inv.createdAt) },
    { label: "Periode", value: period },
    ...(inv.status === "pending" || inv.status === "failed" ? [{ label: "Jatuh tempo", value: date(inv.dueAt) }] : []),
    ...(paid ? [{ label: "Tanggal bayar", value: documentDateTime(timeZone, inv.paidAt!) }] : []),
    ...(via ? [{ label: "Metode pembayaran", value: via }] : []),
  ];

  const lines = [
    {
      description: `Langganan OmniSeller paket ${input.planName}`,
      detail: `${inv.kind === "upgrade" ? "Naik paket" : "Perpanjangan"}, ${dated ? `1 bulan: ${period}` : period}`,
      amount: formatRupiah(inv.amount + inv.creditAmount),
    },
    ...(inv.creditAmount > 0
      ? [
          {
            description: "Potongan sisa paket sebelumnya",
            detail: "Sisa periode yang sudah dibayar, dihitung saat tagihan dibuat",
            amount: formatRupiah(-inv.creditAmount),
          },
        ]
      : []),
  ];

  const totals = [
    { label: "Total", value: formatRupiah(inv.amount), strong: true },
    ...(paid ? [{ label: "Dibayar", value: formatRupiah(inv.paidAmount ?? inv.amount), strong: false }] : []),
  ];

  return {
    title: "TAGIHAN",
    number: inv.number,
    status: inv.status,
    statusLabel: STATUS_LABEL[inv.status],
    facts,
    issuer: issuerParty(input.issuer),
    billTo: billToParty(input.billTo),
    lines,
    totals,
    notes: [payNote(inv) ?? STATUS_NOTE[inv.status], SYSTEM_NOTE].filter((n): n is string => !!n),
  };
}

/** Where a waiting invoice is paid: Xendit's page once the worker has it, which whoever holds the PDF may open. */
function payNote(inv: Pick<InvoiceFacts, "status" | "invoiceUrl">): string | null {
  if (inv.status !== "pending" || !inv.invoiceUrl) return null;
  return `Bayar di ${inv.invoiceUrl} atau lewat menu Langganan & Tagihan di OmniSeller.`;
}

/** The file name a browser saves the PDF as. */
export function invoiceFileName(number: string): string {
  return `${number}.pdf`;
}
