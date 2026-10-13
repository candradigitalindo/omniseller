import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { orderNewArrived } from "../orders/orders.events";
import { AutoArrangeService } from "./auto-arrange.service";
import { AutoProcessService } from "./auto-process.service";

/**
 * Backend doc 8.37 (PRD FR-ORD-19, target under a minute): a new order the seller ships is checked against
 * the business's automatic rules as soon as it arrives. Once per order: the run's history entry keeps a
 * retry from acting twice.
 */
export const orderAutoProcessJob = defineJob({
  queue: "order.ingest",
  name: "order.auto_process",
  schema: z.object({ orderId: ulidSchema }),
  triggeredBy: [orderNewArrived],
  options: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p) => jobKey("order.auto_process", p.orderId),
  handler: async (p, run) => {
    await run.deps.resolve(AutoProcessService).run(run.ctx, p.orderId);
  },
});

/**
 * Backend doc 8.37: orders whose rule arranges the shipment at a time of day, once that time came. Queued
 * by the scheduler's `order.auto_arrange_scan` per business and minute; `until` is the scan's moment, so
 * the job arranges what was due then and the test harness can hand it any moment.
 */
export const orderAutoArrangeJob = defineJob({
  queue: "order.ingest",
  name: "order.auto_arrange",
  schema: z.object({ slot: z.string().min(1), until: z.iso.datetime() }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p) => jobKey("order.auto_arrange", p.tenantId, p.slot),
  handler: async (p, run) => {
    await run.deps.resolve(AutoArrangeService).arrangeDue(run.ctx, new Date(p.until));
  },
});

export const AUTOMATION_JOBS = [orderAutoProcessJob, orderAutoArrangeJob];
