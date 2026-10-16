import { newId } from "@omniseller/shared";
import { and, asc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import type { Tx } from "../../db/client";
import { webhookInbox } from "../../db/schema/sync";
import type { Outbox } from "../../outbox/outbox";
import { webhookReplayRequested } from "./sync.events";

/** Reset and enqueue are atomic; only verified notifications routed to this tenant can be replayed. */
export async function replayWebhooksIn(
  tx: Tx,
  ctx: RequestContext,
  outbox: Outbox,
  input: { id?: string; source?: string; since?: Date; force: boolean; limit: number; dryRun: boolean },
) {
  const rows = await tx
    .select({ id: webhookInbox.id })
    .from(webhookInbox)
    .where(
      and(
        eq(webhookInbox.tenantId, ctx.tenantId),
        eq(webhookInbox.signatureValid, true),
        isNotNull(webhookInbox.storeId),
        input.id ? eq(webhookInbox.id, input.id) : undefined,
        input.source ? eq(webhookInbox.source, input.source) : undefined,
        input.since ? gte(webhookInbox.receivedAt, input.since) : undefined,
        input.force ? undefined : isNull(webhookInbox.processedAt),
      ),
    )
    .orderBy(asc(webhookInbox.receivedAt), asc(webhookInbox.id))
    .limit(input.limit + 1)
    .for("update", { skipLocked: true });
  if (input.id && rows.length === 0) throw new Error("no eligible webhook (processed rows require --force)");
  for (const row of rows.slice(0, input.limit)) {
    if (input.dryRun) continue;
    await tx
      .update(webhookInbox)
      .set({ processedAt: null, lastError: null })
      .where(and(eq(webhookInbox.id, row.id), eq(webhookInbox.tenantId, ctx.tenantId)));
    await outbox.enqueue(tx, ctx, webhookReplayRequested, { inboxId: row.id, replayId: newId() }, row.id);
  }
  return { selected: Math.min(rows.length, input.limit), more: rows.length > input.limit };
}
