import { createHash } from "node:crypto";
import { newId } from "@omniseller/shared";
import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client";
import { idempotencyRecord } from "../db/schema";
import type { RequestContext } from "./context/request-context";
import { UnprocessableError, ValidationError } from "./errors/domain-errors";

const KEY = /^[A-Za-z0-9_.:-]{8,100}$/;

/** The Idempotency-Key header (backend doc 10.2), checked; undefined when the request has none. */
export function idempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim();
  if (!KEY.test(key)) {
    throw new ValidationError([
      {
        path: "Idempotency-Key",
        message: "8 sampai 100 karakter: huruf, angka, titik, titik dua, garis bawah, atau tanda hubung.",
      },
    ]);
  }
  return key;
}

/** Fingerprint of a validated request body: the same key with another body is refused. */
export const requestHash = (body: unknown): string => createHash("sha256").update(JSON.stringify(body)).digest("hex");

/**
 * Claims an Idempotency-Key for a record about to be created, inside the transaction that creates it.
 * Returns null when the key is new (create the record with `resourceId`), or the id of the record an
 * earlier request with this key created. A request still running with the same key makes this wait
 * until it commits or rolls back (unique index). The same key with another body is refused.
 */
export async function claimIdempotencyKey(
  tx: Tx,
  ctx: RequestContext,
  claim: { scope: string; key: string; hash: string; resourceId: string },
): Promise<string | null> {
  const inserted = await tx
    .insert(idempotencyRecord)
    .values({
      id: newId(),
      tenantId: ctx.tenantId,
      scope: claim.scope,
      key: claim.key,
      requestHash: claim.hash,
      resourceId: claim.resourceId,
      createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
    })
    .onConflictDoNothing({ target: [idempotencyRecord.tenantId, idempotencyRecord.scope, idempotencyRecord.key] })
    .returning({ id: idempotencyRecord.id });
  if (inserted.length > 0) return null;
  const [earlier] = await tx
    .select({ requestHash: idempotencyRecord.requestHash, resourceId: idempotencyRecord.resourceId })
    .from(idempotencyRecord)
    .where(and(eq(idempotencyRecord.scope, claim.scope), eq(idempotencyRecord.key, claim.key)));
  if (!earlier || earlier.requestHash !== claim.hash) {
    throw new UnprocessableError("idempotency.key_reused", "Idempotency-Key ini sudah dipakai untuk permintaan lain.");
  }
  return earlier.resourceId;
}
