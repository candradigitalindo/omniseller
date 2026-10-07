import { INVOICE_STATUSES, SUBSCRIPTION_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { PlanView } from "../identity/tenants.service";
import type { InvoiceRow } from "./billing.repository";
import type { BillingOverview } from "./billing-overview.service";

/** Langganan & Tagihan (UI L45, backend doc 8.32). */

const iso = z.iso.datetime();
const count = z.object({
  value: z.number().int(),
  limit: z.number().int().nullable().describe("kuota paket; null tidak dibatasi"),
});

const planSchema = z.object({
  code: z.string(),
  name: z.string(),
  priceMonthly: z.number().int().describe("rupiah per bulan; 0 untuk paket gratis"),
  limits: z.object({
    stores: z.number().int().nullable(),
    warehouses: z.number().int().nullable(),
    ordersPerMonth: z.number().int().nullable(),
    users: z.number().int().nullable(),
  }),
  features: z.array(z.string()),
});

const invoiceSchema = z.object({
  id: ulidSchema,
  number: z.string(),
  kind: z
    .enum(["renewal", "upgrade"])
    .describe("renewal: periode setelah yang berjalan; upgrade: naik paket sejak dibayar"),
  planCode: z.string(),
  planName: z.string(),
  status: z.enum(INVOICE_STATUSES),
  amount: z.number().int().describe("yang dibayar: harga paket dikurangi creditAmount"),
  creditAmount: z.number().int().describe("sisa periode berbayar yang dipotongkan saat naik paket"),
  periodStart: iso,
  periodEnd: iso,
  dueAt: iso,
  paidAt: iso.nullable(),
  paidAmount: z.number().int().nullable(),
  paymentMethod: z.string().nullable(),
  paymentChannel: z.string().nullable(),
  invoiceUrl: z.string().nullable().describe("halaman pembayaran Xendit; null selagi worker menyiapkannya"),
  invoiceExpiresAt: iso.nullable(),
  error: z.string().nullable(),
  createdAt: iso,
});
export class InvoiceDto extends createZodDto(invoiceSchema) {}
export class InvoiceListDto extends createZodDto(z.object({ items: z.array(invoiceSchema), next_cursor: z.null() })) {}
export class InvoiceIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export class BillingStateDto extends createZodDto(
  z.object({
    plan: planSchema.describe("paket yang berlaku sekarang"),
    status: z.enum(SUBSCRIPTION_STATUSES),
    currentPeriodStart: iso,
    currentPeriodEnd: iso.nullable().describe("null untuk paket gratis"),
    nextPlan: planSchema
      .nullable()
      .describe("paket yang berlaku saat periode ini berakhir; null: paket yang sama diperpanjang"),
    lapsesAt: iso.nullable().describe("paket berhenti bila belum dibayar: akhir uji coba, atau akhir masa tenggang"),
    paymentsAvailable: z.boolean().describe("Xendit siap di lingkungan ini, jadi paket berbayar bisa dipilih"),
    usage: z.object({
      orders: count.extend({ period: z.string().describe("bulan zona waktu bisnis, YYYY-MM") }),
      stores: count,
      warehouses: count,
      users: count,
    }),
    plans: z.array(planSchema).describe("paket yang ditawarkan, dari yang termurah"),
    pendingInvoice: invoiceSchema.nullable().describe("tagihan yang menunggu dibayar, bila ada"),
    prepaidInvoice: invoiceSchema
      .nullable()
      .describe("periode berikutnya yang sudah dibayar; mulai berlaku saat periode ini berakhir"),
    invoices: z.array(invoiceSchema),
  }),
) {}

export class ChangePlanDto extends createZodDto(
  z.object({ planCode: z.string().regex(/^[a-z_]{2,30}$/, "Kode paket tidak valid.") }),
) {}

export function planDto(p: PlanView) {
  return {
    code: p.code,
    name: p.name,
    priceMonthly: p.priceMonthly,
    limits: {
      stores: p.limits.stores ?? null,
      warehouses: p.limits.warehouses ?? null,
      ordersPerMonth: p.limits.orders_per_month ?? null,
      users: p.limits.users ?? null,
    },
    features: p.features,
  };
}

export function invoiceDto(i: InvoiceRow, plans: PlanView[]) {
  const plan = plans.find((p) => p.id === i.planId);
  return {
    id: i.id,
    number: i.number,
    kind: i.kind,
    planCode: plan?.code ?? "",
    planName: plan?.name ?? "",
    status: i.status,
    amount: i.amount,
    creditAmount: i.creditAmount,
    periodStart: i.periodStart.toISOString(),
    periodEnd: i.periodEnd.toISOString(),
    dueAt: i.dueAt.toISOString(),
    paidAt: i.paidAt?.toISOString() ?? null,
    paidAmount: i.paidAmount,
    paymentMethod: i.paymentMethod,
    paymentChannel: i.paymentChannel,
    invoiceUrl: i.invoiceUrl,
    invoiceExpiresAt: i.invoiceExpiresAt?.toISOString() ?? null,
    error: i.error,
    createdAt: i.createdAt.toISOString(),
  };
}

export function billingStateDto(o: BillingOverview) {
  const s = o.subscription;
  return {
    plan: planDto(s.plan),
    status: s.status,
    currentPeriodStart: s.currentPeriodStart.toISOString(),
    currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
    nextPlan: s.nextPlan ? planDto(s.nextPlan) : null,
    lapsesAt: s.lapsesAt?.toISOString() ?? null,
    paymentsAvailable: o.paymentsAvailable,
    usage: {
      orders: { value: o.usage.orders.value, limit: o.usage.orders.limit, period: o.usage.orders.period },
      stores: o.usage.stores,
      warehouses: o.usage.warehouses,
      users: o.usage.users,
    },
    plans: o.plans.map(planDto),
    pendingInvoice: o.pendingInvoice ? invoiceDto(o.pendingInvoice, o.plans) : null,
    prepaidInvoice: o.prepaidInvoice ? invoiceDto(o.prepaidInvoice, o.plans) : null,
    invoices: o.invoices.map((i) => invoiceDto(i, o.plans)),
  };
}
