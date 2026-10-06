import { Injectable, Module } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lt, or } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { auditLog } from "../../db/schema";

/** What a reader of the audit log narrows it to (backend doc 8.28). */
export interface AuditFilter {
  entityTypes?: string[] | undefined;
  entityId?: string | undefined;
  /** The person (or print agent) who acted. */
  actorId?: string | undefined;
  /** From this moment, inclusive. */
  from?: Date | undefined;
  /** Until this moment, exclusive. */
  to?: Date | undefined;
}

/**
 * Audit log reading (PRD FR-USR-04). Rows are written only by the audit_row() trigger
 * (backend doc 7.7); this module never writes. Other modules import this file, so it imports none of
 * theirs: the readable log, which names records through their owners, is in audit-http.module.ts.
 */
@Injectable()
export class AuditService {
  /** Rows matching the filter, newest first, older than `before` (an entry id), in the caller's transaction. */
  async rowsIn(tx: Tx, filter: AuditFilter, before: string | undefined, limit: number): Promise<AuditRow[]> {
    const types = filter.entityTypes ?? [];
    return tx
      .select()
      .from(auditLog)
      .where(
        and(
          types.length === 1 ? eq(auditLog.entityType, types[0]!) : undefined,
          types.length > 1 ? inArray(auditLog.entityType, types) : undefined,
          filter.entityId ? eq(auditLog.entityId, filter.entityId) : undefined,
          filter.actorId ? eq(auditLog.actorId, filter.actorId) : undefined,
          filter.from ? gte(auditLog.createdAt, filter.from) : undefined,
          filter.to ? lt(auditLog.createdAt, filter.to) : undefined,
          before ? lt(auditLog.id, before) : undefined,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(limit);
  }

  /**
   * Entries about any of these entities, newest first, in the caller's transaction: the history of a
   * record that spans tables (a product and its variants, FR-PRD-11). `before` is an entry id.
   */
  async entriesIn(
    tx: Tx,
    targets: { entityType: string; entityIds: string[] }[],
    before: string | undefined,
    limit: number,
  ): Promise<AuditRow[]> {
    const wanted = targets.filter((t) => t.entityIds.length > 0);
    if (wanted.length === 0) return [];
    return tx
      .select()
      .from(auditLog)
      .where(
        and(
          or(...wanted.map((t) => and(eq(auditLog.entityType, t.entityType), inArray(auditLog.entityId, t.entityIds)))),
          before ? lt(auditLog.id, before) : undefined,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(limit);
  }
}

export type AuditRow = typeof auditLog.$inferSelect;

@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
