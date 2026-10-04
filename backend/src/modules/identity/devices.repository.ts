import { Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { device } from "../../db/schema";

export type DeviceRow = typeof device.$inferSelect;
export type DeviceKind = DeviceRow["kind"];

/** Rows of `device` (owned by identity, backend doc 11). */
@Injectable()
export class DevicesRepository {
  async insert(tx: Tx, row: typeof device.$inferInsert): Promise<DeviceRow> {
    const [r] = await tx.insert(device).values(row).returning();
    return r!;
  }

  async get(tx: Tx, id: string, lock = false): Promise<DeviceRow | undefined> {
    const q = tx.select().from(device).where(eq(device.id, id));
    const [r] = lock ? await q.for("update") : await q;
    return r;
  }

  /** Devices of a kind that still work, newest first. */
  async active(tx: Tx, kind: DeviceKind): Promise<DeviceRow[]> {
    return tx
      .select()
      .from(device)
      .where(and(eq(device.kind, kind), isNull(device.revokedAt)))
      .orderBy(desc(device.id));
  }

  async update(tx: Tx, id: string, patch: Partial<typeof device.$inferInsert>): Promise<DeviceRow> {
    const [r] = await tx.update(device).set(patch).where(eq(device.id, id)).returning();
    return r!;
  }
}
