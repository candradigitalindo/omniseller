import { Injectable } from "@nestjs/common";
import { and, asc, eq, gte, lte, ne, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { courierCutoff, courierHoliday, operatingHours } from "../../db/schema";

export type CourierCutoffRow = typeof courierCutoff.$inferSelect;
export type CourierHolidayRow = typeof courierHoliday.$inferSelect;
export type OperatingHoursRow = typeof operatingHours.$inferSelect;

/**
 * Rows of `courier_cutoff`, `courier_holiday`, and `operating_hours` (owned by the campaign module,
 * backend doc 11). `touch_row` moves `updated_at` and `row_version` on every update.
 */
@Injectable()
export class CampaignRepository {
  // ---- cut-offs ----

  async cutoffs(tx: Tx, onlyActive = false): Promise<CourierCutoffRow[]> {
    return tx
      .select()
      .from(courierCutoff)
      .where(onlyActive ? eq(courierCutoff.active, true) : undefined)
      .orderBy(asc(courierCutoff.warehouseId), asc(courierCutoff.cutoffTime), asc(courierCutoff.courier));
  }

  async cutoff(tx: Tx, id: string, forUpdate = false): Promise<CourierCutoffRow | undefined> {
    const q = tx.select().from(courierCutoff).where(eq(courierCutoff.id, id));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async insertCutoff(tx: Tx, row: typeof courierCutoff.$inferInsert): Promise<void> {
    await tx.insert(courierCutoff).values(row);
  }

  /** False when the row changed since `expected` (If-Match). */
  async updateCutoff(
    tx: Tx,
    id: string,
    patch: Partial<typeof courierCutoff.$inferInsert>,
    expected?: number,
  ): Promise<boolean> {
    const res = await tx
      .update(courierCutoff)
      .set(patch)
      .where(
        expected === undefined
          ? eq(courierCutoff.id, id)
          : and(eq(courierCutoff.id, id), eq(courierCutoff.rowVersion, expected)),
      )
      .returning({ id: courierCutoff.id });
    return res.length > 0;
  }

  async deleteCutoff(tx: Tx, id: string): Promise<boolean> {
    return (
      (await tx.delete(courierCutoff).where(eq(courierCutoff.id, id)).returning({ id: courierCutoff.id })).length > 0
    );
  }

  // ---- holidays ----

  async holidays(tx: Tx, from?: string, to?: string): Promise<CourierHolidayRow[]> {
    return (
      tx
        .select()
        .from(courierHoliday)
        .where(
          and(
            from ? gte(courierHoliday.holidayDate, from) : undefined,
            to ? lte(courierHoliday.holidayDate, to) : undefined,
          ),
        )
        // a holiday of every courier before one courier's, on the same date
        .orderBy(asc(courierHoliday.holidayDate), sql`${courierHoliday.courier} ASC NULLS FIRST`)
    );
  }

  async insertHoliday(tx: Tx, row: typeof courierHoliday.$inferInsert): Promise<void> {
    await tx.insert(courierHoliday).values(row);
  }

  async deleteHoliday(tx: Tx, id: string): Promise<boolean> {
    return (
      (await tx.delete(courierHoliday).where(eq(courierHoliday.id, id)).returning({ id: courierHoliday.id })).length > 0
    );
  }

  // ---- operating hours ----

  async hours(tx: Tx): Promise<OperatingHoursRow[]> {
    return tx
      .select()
      .from(operatingHours)
      .orderBy(sql`${operatingHours.isDefault} DESC`, asc(operatingHours.validFrom), asc(operatingHours.id));
  }

  async hoursRow(tx: Tx, id: string, forUpdate = false): Promise<OperatingHoursRow | undefined> {
    const q = tx.select().from(operatingHours).where(eq(operatingHours.id, id));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async defaultWeek(tx: Tx, forUpdate = false): Promise<OperatingHoursRow | undefined> {
    const q = tx.select().from(operatingHours).where(eq(operatingHours.isDefault, true));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  /** Special periods sharing a date with [from, to], other than `exceptId`. */
  async overlappingPeriods(tx: Tx, from: string, to: string, exceptId?: string): Promise<OperatingHoursRow[]> {
    return tx
      .select()
      .from(operatingHours)
      .where(
        and(
          eq(operatingHours.isDefault, false),
          lte(operatingHours.validFrom, to),
          gte(operatingHours.validTo, from),
          exceptId ? ne(operatingHours.id, exceptId) : undefined,
        ),
      );
  }

  /** Special periods are checked for overlap one writer per business at a time, until the transaction ends. */
  async lockHours(tx: Tx, tenantId: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:operating_hours`}, 0))`);
  }

  async insertHours(tx: Tx, row: typeof operatingHours.$inferInsert): Promise<void> {
    await tx.insert(operatingHours).values(row);
  }

  async updateHours(tx: Tx, id: string, patch: Partial<typeof operatingHours.$inferInsert>): Promise<void> {
    await tx.update(operatingHours).set(patch).where(eq(operatingHours.id, id));
  }

  async deleteHours(tx: Tx, id: string): Promise<boolean> {
    return (
      (await tx.delete(operatingHours).where(eq(operatingHours.id, id)).returning({ id: operatingHours.id })).length > 0
    );
  }
}
