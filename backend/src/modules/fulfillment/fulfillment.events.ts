import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/** The seller asked to arrange pickup or drop-off for these shipments of one store (FR-SHP-06). */
export const shipmentArrangeRequested = defineEvent({
  type: "shipment.arrange_requested",
  aggregate: "store",
  schema: z.object({
    storeId: ulidSchema,
    shipmentIds: z.array(ulidSchema).min(1).max(500),
    method: z.enum(["pickup", "dropoff"]),
  }),
});

/** Labels of arranged shipments should be fetched (after arranging, or when the marketplace says they are ready). */
export const shipmentLabelRequested = defineEvent({
  type: "shipment.label_requested",
  aggregate: "shipment",
  schema: z.object({ shipmentIds: z.array(ulidSchema).min(1).max(500) }),
});

/** A shipment carrying a rule's print instruction has its label ready (FR-SHP-18, backend doc 8.37). */
export const shipmentPrintDue = defineEvent({
  type: "shipment.print_due",
  aggregate: "shipment",
  schema: z.object({ shipmentId: ulidSchema }),
});

/** A printable document (labels in one PDF, pick list) should be rendered. */
export const documentRequested = defineEvent({
  type: "document.requested",
  aggregate: "document",
  schema: z.object({ documentId: ulidSchema }),
});

/** The parcels of these orders should be tracked now (the seller pressed "Perbarui"). */
export const shipmentTrackingRequested = defineEvent({
  type: "shipment.tracking_requested",
  aggregate: "order",
  schema: z.object({ orderIds: z.array(ulidSchema).min(1).max(100) }),
});
