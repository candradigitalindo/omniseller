import { isUlid } from "@omniseller/shared";
import { z } from "zod";
import { ValidationError } from "../errors/domain-errors";

/**
 * Cursor pagination (backend doc 7.10, 10.1): the cursor is the last ULID seen, base64url-encoded so
 * clients treat it as opaque. Lists are ordered by id descending (newest first) unless stated.
 */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export const paginationQuery = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!isUlid(id)) throw new ValidationError([{ path: "cursor", message: "Cursor tidak valid." }]);
  return id;
}

/** Callers fetch limit + 1 rows; this trims and computes next_cursor. */
export function page<T extends { id: string }>(rows: T[], limit: number): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, next_cursor: rows.length > limit && last ? encodeCursor(last.id) : null };
}

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });
