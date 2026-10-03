import { ORDER_STATUSES, ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { orderStatusChanged } from "../orders/orders.events";
import type { WebhookConsumer, WebhookConsumers } from "../sync/webhook-consumer";
import { DocumentRenderService } from "./document-render.service";
import { documentRequested, shipmentArrangeRequested, shipmentLabelRequested } from "./fulfillment.events";
import { FulfillmentWorkerService } from "./fulfillment-worker.service";

const shipmentIds = z.array(ulidSchema).min(1).max(500);

/** FR-SHP-06: pickup or drop-off at the marketplace for one store's shipments. */
export const shipmentArrangeJob = defineJob({
  queue: "mp.outbound",
  name: "shipment.arrange",
  schema: z.object({ storeId: ulidSchema, shipmentIds, method: z.enum(["pickup", "dropoff"]) }),
  triggeredBy: [shipmentArrangeRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p, meta) => jobKey("shipment.arrange", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(FulfillmentWorkerService).arrange(run.ctx, p, run.jobId);
  },
});

/**
 * Labels of arranged shipments. The courier's tracking number and the marketplace's label can take
 * minutes: a job with labels still pending fails on purpose and runs again, about 30 minutes in all.
 */
export const labelFetchJob = defineJob({
  queue: "mp.outbound",
  name: "label.fetch",
  schema: z.object({ shipmentIds }),
  triggeredBy: [shipmentLabelRequested],
  options: { attempts: 8, backoff: { type: "exponential", delay: 15_000 } },
  jobId: (p, meta) => jobKey("label.fetch", p.shipmentIds[0]!, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(FulfillmentWorkerService).fetchLabels(run.ctx, p.shipmentIds, run.jobId);
  },
});

/** FR-SHP-01, 02: labels in one PDF, or the pick list. */
export const documentRenderJob = defineJob({
  queue: "pdf",
  name: "document.render",
  schema: z.object({ documentId: ulidSchema }),
  triggeredBy: [documentRequested],
  options: { attempts: 2, backoff: { type: "fixed", delay: 10_000 } },
  jobId: (p) => jobKey("document.render", p.documentId),
  handler: async (p, run) => {
    await run.deps.resolve(DocumentRenderService).render(run.ctx, p.documentId);
  },
});

/** The shipment follows its order: cancelled, picked up, delivered, packed (doc 7.9). */
export const shipmentFollowOrderJob = defineJob({
  queue: "order.ingest",
  name: "shipment.follow_order",
  schema: z.object({
    orderId: ulidSchema,
    from: z.enum(ORDER_STATUSES),
    to: z.enum(ORDER_STATUSES),
    actorType: z.enum(["user", "system", "marketplace"]),
    actorId: ulidSchema.nullable(),
  }),
  triggeredBy: [orderStatusChanged],
  options: { attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
  jobId: (p, meta) => jobKey("shipment.follow_order", p.orderId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(FulfillmentWorkerService).followOrder(run.ctx, p);
  },
});

export const FULFILLMENT_JOBS = [shipmentArrangeJob, labelFetchJob, documentRenderJob, shipmentFollowOrderJob];

/** Shopee push 4 (tracking number) and 15 (shipping document ready): fetch the label now. */
const labelsFromPush: WebhookConsumer = async (run, event) => {
  if (!event.data.externalOrderId) return;
  await run.deps
    .resolve(FulfillmentWorkerService)
    .labelsForOrders(run.ctx, event.storeId, [event.data.externalOrderId]);
};

export const FULFILLMENT_WEBHOOK_CONSUMERS: WebhookConsumers = {
  "order.tracking_updated": [labelsFromPush],
  "shipment.document_ready": [labelsFromPush],
};
