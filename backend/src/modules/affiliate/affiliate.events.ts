import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";
export const affiliateProductsRequested = defineEvent({
  type: "affiliate.products_requested",
  aggregate: "affiliate_product_query",
  schema: z.object({ requestId: ulidSchema }),
});
