import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

const money = z.number().int();
const n = z.number().int();

export const digestSummarySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sales: z
    .object({
      orders: n,
      revenue: money,
      previousOrders: n,
      previousRevenue: money,
      top: z.array(z.object({ name: z.string(), units: n })).max(5),
    })
    .nullable(),
  orders: z.object({ new: n, toShip: n, overdue: n, dueSoon: n, problem: n }).nullable(),
  stock: z
    .object({
      critical: n,
      items: z.array(z.object({ sku: z.string(), name: z.string(), available: n, warehouse: z.string() })).max(10),
    })
    .nullable(),
  stores: z.array(z.object({ name: z.string(), reason: z.string() })).nullable(),
});

/** One person's daily operational email, figures in their store and warehouse scope (FR-NTF-02). */
export const digestEmailRequested = defineEvent({
  type: "digest.email_requested",
  aggregate: "user",
  schema: z.object({ userId: ulidSchema, tenantName: z.string(), summary: digestSummarySchema }),
});
