import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

export const webhookReplayRequested = defineEvent({
  type: "webhook.replay_requested",
  aggregate: "webhook",
  schema: z.object({ inboxId: ulidSchema, replayId: ulidSchema }),
});
