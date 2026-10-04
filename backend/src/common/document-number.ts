import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { documentSequence } from "../db/schema";

/**
 * The next number of a document kind in a period (backend doc 7.8.5, 8.21). `document_sequence` is
 * shared by the modules that number documents: manual orders now, purchase orders later. The number is
 * taken inside the document's own transaction, so the row stays locked until it commits: numbers never
 * repeat, two requests for the same period wait for each other, and a document that rolls back gives
 * its number back.
 */
export async function nextDocumentNumber(tx: Tx, tenantId: string, kind: string, period: string): Promise<number> {
  const [row] = await tx
    .insert(documentSequence)
    .values({ id: newId(), tenantId, kind, period, nextValue: 2 })
    .onConflictDoUpdate({
      target: [documentSequence.tenantId, documentSequence.kind, documentSequence.period],
      set: { nextValue: sql.raw('"document_sequence"."next_value" + 1') },
    })
    .returning({ next: documentSequence.nextValue });
  return row!.next - 1;
}
