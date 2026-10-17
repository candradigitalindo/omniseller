import { Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { commerceOperation } from "../../db/schema/commerce";
export type CommerceRow = typeof commerceOperation.$inferSelect;
@Injectable()
export class CommerceRepository {
  async get(tx: Tx, id: string) {
    return (await tx.select().from(commerceOperation).where(eq(commerceOperation.id, id)))[0];
  }
  list(
    tx: Tx,
    filter: { principalId?: string; cursor?: string; limit: number; storeScope: ReadonlySet<string> | null },
  ) {
    return tx
      .select()
      .from(commerceOperation)
      .where(
        and(
          gt(commerceOperation.expiresAt, new Date()),
          filter.cursor ? lt(commerceOperation.id, filter.cursor) : undefined,
          filter.principalId
            ? or(eq(commerceOperation.storeId, filter.principalId), eq(commerceOperation.accountId, filter.principalId))
            : undefined,
          filter.storeScope === null
            ? undefined
            : or(isNull(commerceOperation.storeId), inArray(commerceOperation.storeId, [...filter.storeScope])),
        ),
      )
      .orderBy(desc(commerceOperation.id))
      .limit(filter.limit);
  }
  async insert(tx: Tx, values: typeof commerceOperation.$inferInsert) {
    // API grants name request metadata only; it cannot fabricate worker results/status/claims.
    await tx.execute(sql`INSERT INTO commerce_operation
      (id,tenant_id,operation_id,principal_kind,store_id,account_id,requested_by,is_write,input,expires_at)
      VALUES (${values.id},${values.tenantId},${values.operationId},${values.principalKind},${values.storeId ?? null},${values.accountId ?? null},${values.requestedBy ?? null},${values.isWrite},${JSON.stringify(values.input)}::jsonb,${values.expiresAt})`);
    return (await this.get(tx, values.id!))!;
  }
  async claim(tx: Tx, id: string, claimId: string) {
    return (
      await tx
        .update(commerceOperation)
        .set({ status: "running", claimId, claimedAt: new Date() })
        .where(
          and(
            eq(commerceOperation.id, id),
            or(
              eq(commerceOperation.status, "queued"),
              and(
                eq(commerceOperation.status, "running"),
                lt(commerceOperation.claimedAt, new Date(Date.now() - 300_000)),
              ),
            ),
          ),
        )
        .returning()
    )[0];
  }
  async dispatch(tx: Tx, id: string, claimId: string) {
    return (
      await tx
        .update(commerceOperation)
        .set({ dispatchedAt: new Date() })
        .where(and(eq(commerceOperation.id, id), eq(commerceOperation.claimId, claimId)))
        .returning()
    )[0];
  }
  async finish(tx: Tx, id: string, claimId: string, values: Partial<CommerceRow>) {
    const updated = await tx
      .update(commerceOperation)
      .set({ ...values, claimId: null, claimedAt: null })
      .where(
        and(
          eq(commerceOperation.id, id),
          eq(commerceOperation.claimId, claimId),
          eq(commerceOperation.status, "running"),
        ),
      )
      .returning({ id: commerceOperation.id });
    return updated.length > 0;
  }
  async cleanup(tx: Tx) {
    // Raw inputs/results are cache data, never part of the permanent audit history.
    await tx
      .update(commerceOperation)
      .set({ input: {}, result: null })
      .where(
        and(
          lt(commerceOperation.expiresAt, new Date()),
          or(sql`${commerceOperation.input}<>'{}'::jsonb`, isNotNull(commerceOperation.result)),
        ),
      );
  }
  exportPage(tx: Tx, after: string | undefined, limit: number) {
    return tx
      .select()
      .from(commerceOperation)
      .where(after ? gt(commerceOperation.id, after) : undefined)
      .orderBy(commerceOperation.id)
      .limit(limit);
  }
}
