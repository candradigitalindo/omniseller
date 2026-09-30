import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { AuthService } from "../auth/auth.service";
import { invitationSendRequested, passwordResetRequested } from "./identity.events";
import { InvitationsService } from "./invitations.service";

/**
 * Account emails (backend doc 11: identity.invite_email). Per-occurrence ids: every resend or
 * reset request is its own job, while a relay retry of the same outbox row is dropped by BullMQ.
 */
export const inviteEmailJob = defineJob({
  queue: "notify",
  name: "identity.invite_email",
  schema: z.object({ invitationId: z.string() }),
  triggeredBy: [invitationSendRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p, meta) => jobKey("identity.invite_email", p.invitationId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(InvitationsService).send(run.ctx, p.invitationId);
  },
});

export const passwordResetEmailJob = defineJob({
  queue: "notify",
  name: "auth.password_reset_email",
  schema: z.object({ userId: z.string() }),
  triggeredBy: [passwordResetRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p, meta) => jobKey("auth.password_reset_email", p.userId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(AuthService).sendPasswordReset(run.ctx, p.userId);
  },
});

export const IDENTITY_JOBS = [inviteEmailJob, passwordResetEmailJob];
