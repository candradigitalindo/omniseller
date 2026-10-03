import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/** A full data export was requested (FR-MIG-09); the worker renders it. */
export const exportRequested = defineEvent({
  type: "export.requested",
  aggregate: "data_export",
  schema: z.object({ exportId: ulidSchema }),
});
