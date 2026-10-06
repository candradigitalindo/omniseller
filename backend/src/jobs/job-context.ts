import { z } from "zod";
import { type RequestContext, systemContext } from "../common/context/request-context";
import type { JobDef } from "./define";

/** Who asked for a job that acts for its requester, as the outbox keeps it in the payload. */
export const requesterSchema = z.object({
  type: z.enum(["user", "api_key", "device"]),
  id: z.string().min(1).max(64),
});
export type Requester = z.infer<typeof requesterSchema>;

/**
 * What the outbox adds to a job's payload (`requestedBy`): the person or agent whose request started it,
 * for jobs that carry out that request (`actsForRequester`). Nothing for other jobs, or when the system
 * itself asked. Job schemas never declare it, so handlers do not see it.
 */
export function requesterOf(
  def: Pick<JobDef, "actsForRequester">,
  ctx: RequestContext,
): { requestedBy: Requester } | Record<string, never> {
  if (!def.actsForRequester || ctx.actor.type === "system") return {};
  return { requestedBy: { type: ctx.actor.type, id: ctx.actor.id } };
}

/**
 * The context a job runs in: the system, or for a job that carries out what a person asked for (a
 * listing switched off, a count applied), that person, so its writes are audited under their name
 * (backend doc 8.28). Permissions and scope stay the system's: the person was allowed when they asked.
 * A job that starts the next one passes the person on through the outbox the same way.
 */
export function jobContext(
  def: Pick<JobDef, "actsForRequester">,
  tenantId: string,
  requestId: string | undefined,
  data: unknown,
): RequestContext {
  const ctx = systemContext(tenantId, requestId ? { requestId } : {});
  if (!def.actsForRequester || !data || typeof data !== "object") return ctx;
  const asked = requesterSchema.safeParse((data as Record<string, unknown>).requestedBy);
  return asked.success ? { ...ctx, actor: asked.data } : ctx;
}
