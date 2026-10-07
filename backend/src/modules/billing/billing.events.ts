import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/** An invoice row was written; the worker asks Xendit for its payment page (backend doc 8.32). */
export const billingInvoiceRequested = defineEvent({
  type: "billing.invoice_requested",
  aggregate: "invoice",
  schema: z.object({ invoiceId: ulidSchema }),
});

/** An invoice was withdrawn (another plan, a lapse, by hand): its Xendit page must stop taking payment. */
export const billingInvoiceVoided = defineEvent({
  type: "billing.invoice_voided",
  aggregate: "invoice",
  schema: z.object({ invoiceId: ulidSchema }),
});
