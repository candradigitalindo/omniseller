/**
 * BullMQ job ids (backend doc 9.2). BullMQ rejects custom ids containing ':' (reserved for its own
 * keys), so parts are joined with '|'.
 *
 * Two kinds of ids:
 * - once per entity: the action must happen at most once, e.g. `order.accept|<order_id>`.
 * - per occurrence: the action may legitimately recur for the same entity (price push, stock push,
 *   notification). The id includes what makes the occurrence unique (the outbox event id or the
 *   dirty-set score), so BullMQ still drops a relay retry of the same occurrence but never drops a
 *   later one. A business key alone would be silently rejected while the finished job is retained
 *   (removeOnComplete keeps it for an hour).
 */
export const JOB_ID_SEPARATOR = "|";

export function jobKey(...parts: (string | number)[]): string {
  for (const part of parts) {
    const s = String(part);
    if (s.length === 0 || s.includes(":") || s.includes(JOB_ID_SEPARATOR)) {
      throw new Error(`invalid job id part: "${s}"`);
    }
  }
  const id = parts.join(JOB_ID_SEPARATOR);
  if (/^\d+$/.test(id)) throw new Error("job id cannot be an integer");
  return id;
}
