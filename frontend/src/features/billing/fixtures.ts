import type { BillingState, Invoice, Plan } from "./billing-meta";

export const PLANS: Plan[] = [
  {
    code: "starter",
    name: "Starter",
    priceMonthly: 0,
    limits: { stores: 2, warehouses: 1, ordersPerMonth: 1000, users: 2 },
    features: [],
  },
  {
    code: "growth",
    name: "Growth",
    priceMonthly: 899_000,
    limits: { stores: 10, warehouses: 2, ordersPerMonth: 10_000, users: 10 },
    features: [
      "auto_process",
      "promo_auto_renew",
      "boost",
      "customer_receivable",
      "staff_report",
      "custom_roles",
      "chat",
    ],
  },
  {
    code: "business",
    name: "Business",
    priceMonthly: 2_499_000,
    limits: { stores: null, warehouses: null, ordersPerMonth: 100_000, users: null },
    features: ["auto_process", "promo_auto_renew", "boost", "chat", "accounting", "public_api", "distribution"],
  },
];
export const [STARTER, GROWTH, BUSINESS] = PLANS as [Plan, Plan, Plan];

/** A business on its 14-day trial of Growth, as the api answers (backend doc 8.32). */
export const TRIAL: BillingState = {
  plan: GROWTH,
  status: "trialing",
  currentPeriodStart: "2026-10-01T03:00:00.000Z",
  currentPeriodEnd: "2026-10-15T03:00:00.000Z",
  nextPlan: null,
  lapsesAt: "2026-10-15T03:00:00.000Z",
  paymentsAvailable: true,
  usage: {
    orders: { value: 3_200, limit: 10_000, period: "2026-10" },
    stores: { value: 5, limit: 10 },
    warehouses: { value: 1, limit: 2 },
    users: { value: 3, limit: 10 },
  },
  plans: PLANS,
  pendingInvoice: null,
  prepaidInvoice: null,
  invoices: [],
};

export function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: "01JINV00000000000000000001",
    number: "INV-2610-0001",
    kind: "upgrade",
    planCode: "business",
    planName: "Business",
    status: "pending",
    amount: 2_499_000,
    creditAmount: 0,
    periodStart: "2026-10-07T04:00:00.000Z",
    periodEnd: "2026-11-07T04:00:00.000Z",
    dueAt: "2026-10-08T04:00:00.000Z",
    paidAt: null,
    paidAmount: null,
    paymentMethod: null,
    paymentChannel: null,
    invoiceUrl: "https://checkout.xendit.co/web/abc123",
    invoiceExpiresAt: "2026-10-08T04:00:00.000Z",
    error: null,
    createdAt: "2026-10-07T04:00:00.000Z",
    ...over,
  };
}

const PAID_SEPTEMBER = invoice({
  id: "01JINV00000000000000000001",
  number: "INV-2609-0001",
  kind: "renewal",
  planCode: "growth",
  planName: "Growth",
  status: "paid",
  amount: 899_000,
  periodStart: "2026-09-12T04:00:00.000Z",
  periodEnd: "2026-10-12T04:00:00.000Z",
  dueAt: "2026-09-12T04:00:00.000Z",
  paidAt: "2026-09-12T05:10:00.000Z",
  paidAmount: 899_000,
  paymentMethod: "BANK_TRANSFER",
  paymentChannel: "BCA",
  invoiceUrl: null,
  invoiceExpiresAt: null,
  createdAt: "2026-09-05T04:00:00.000Z",
});

const RENEWAL = invoice({
  id: "01JINV00000000000000000002",
  number: "INV-2610-0002",
  kind: "renewal",
  planCode: "growth",
  planName: "Growth",
  amount: 899_000,
  periodStart: "2026-10-12T04:00:00.000Z",
  periodEnd: "2026-11-12T04:00:00.000Z",
  dueAt: "2026-10-12T04:00:00.000Z",
  invoiceExpiresAt: "2026-10-19T04:00:00.000Z",
});

/** A paid month of Growth with the renewal invoice waiting. */
export const ACTIVE: BillingState = {
  ...TRIAL,
  status: "active",
  currentPeriodStart: "2026-09-12T04:00:00.000Z",
  currentPeriodEnd: "2026-10-12T04:00:00.000Z",
  lapsesAt: null,
  pendingInvoice: RENEWAL,
  invoices: [RENEWAL, PAID_SEPTEMBER],
};

/** A paid month of Business, nothing scheduled, the renewal not made yet. */
export const ON_BUSINESS: BillingState = {
  ...ACTIVE,
  plan: BUSINESS,
  pendingInvoice: null,
  invoices: [PAID_SEPTEMBER],
};
