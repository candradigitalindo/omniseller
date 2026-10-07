import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { tenantCreated } from "../identity/identity.events";
import { billingInvoiceRequested, billingInvoiceVoided } from "./billing.events";
import { BillingService } from "./billing.service";
import { BillingWorkerService } from "./billing-worker.service";

/** A new business: its 14-day trial of Growth (backend doc 8.32). The scan also sends this for a tenant without any row. */
export const billingTrialStartJob = defineJob({
  queue: "billing",
  name: "billing.trial_start",
  schema: z.object({ slot: z.string().min(1).optional() }),
  triggeredBy: [tenantCreated],
  options: { attempts: 5, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p, meta) => jobKey("billing.trial_start", p.tenantId, meta.eventId ?? p.slot ?? "direct"),
  handler: async (_p, run) => {
    await run.deps.resolve(BillingService).startTrial(run.ctx);
  },
});

/** The payment page of an invoice, from Xendit. */
export const billingInvoiceCreateJob = defineJob({
  queue: "billing",
  name: "billing.invoice_create",
  schema: z.object({ invoiceId: ulidSchema }),
  triggeredBy: [billingInvoiceRequested],
  options: { attempts: 8, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("billing.invoice_create", p.invoiceId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(BillingWorkerService).createXenditInvoice(run.ctx, p.invoiceId);
  },
});

/** Closes the Xendit page of a withdrawn invoice, once per withdrawal. */
export const billingInvoiceExpireJob = defineJob({
  queue: "billing",
  name: "billing.invoice_expire",
  schema: z.object({ invoiceId: ulidSchema }),
  triggeredBy: [billingInvoiceVoided],
  options: { attempts: 8, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("billing.invoice_expire", p.invoiceId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(BillingWorkerService).expireXenditInvoice(run.ctx, p.invoiceId);
  },
});

/** One Xendit callback, enqueued by the webhook process; its `webhook-id` keeps a repeat delivery one job. */
export const billingInvoiceCallbackJob = defineJob({
  queue: "billing",
  name: "billing.invoice_callback",
  schema: z.object({
    invoiceId: ulidSchema,
    webhookId: z.string().min(1).max(120),
    xenditInvoiceId: z.string().min(1).max(120),
    status: z.string().min(1).max(40),
    paidAt: z.string().optional(),
    paidAmount: z.number().optional(),
    paymentMethod: z.string().max(80).optional(),
    paymentChannel: z.string().max(80).optional(),
  }),
  options: { attempts: 5, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p) => jobKey("billing.invoice_callback", p.invoiceId, p.webhookId),
  handler: async (p, run) => {
    await run.deps.resolve(BillingService).applyCallback(run.ctx, p);
  },
});

/** Reminders, the renewal invoice, and lapsing, for a tenant the hourly scan picked. */
export const billingRenewJob = defineJob({
  queue: "billing",
  name: "billing.renew",
  schema: z.object({ slot: z.string().min(1) }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  jobId: (p) => jobKey("billing.renew", p.tenantId, p.slot),
  handler: async (_p, run) => {
    await run.deps.resolve(BillingService).renew(run.ctx);
  },
});

export const BILLING_JOBS = [
  billingTrialStartJob,
  billingInvoiceCreateJob,
  billingInvoiceExpireJob,
  billingInvoiceCallbackJob,
  billingRenewJob,
];
