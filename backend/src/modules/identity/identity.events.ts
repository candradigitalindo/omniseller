import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/** An invitation must be (re)sent. The job issues a fresh token, so a resend invalidates the old link. */
export const invitationSendRequested = defineEvent({
  type: "invitation.send_requested",
  aggregate: "invitation",
  schema: z.object({ invitationId: ulidSchema }),
});

/** A user asked for a password reset link. The job creates the token and sends it. */
export const passwordResetRequested = defineEvent({
  type: "password_reset.requested",
  aggregate: "user",
  schema: z.object({ userId: ulidSchema }),
});
