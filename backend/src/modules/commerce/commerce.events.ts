import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";
export const commerceRequested = defineEvent({
  type: "commerce.requested",
  aggregate: "commerce_operation",
  schema: z.object({ requestId: ulidSchema }),
});
