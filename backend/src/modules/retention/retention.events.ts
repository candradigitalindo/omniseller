import { z } from "zod";
import { defineEvent } from "../../jobs/define";

export const tenantPurgeRequested = defineEvent({
  type: "tenant.purge_requested",
  aggregate: "tenant",
  schema: z.object({ slot: z.string().min(1) }),
});
