import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { documentJob, labelTemplate, shipment, shipmentPackage } from "../../db/schema";

export type ShipmentRow = typeof shipment.$inferSelect;
export type PackageRow = typeof shipmentPackage.$inferSelect;
export type DocumentRow = typeof documentJob.$inferSelect;
export type LabelTemplateRow = typeof labelTemplate.$inferSelect;

@Injectable()
export class FulfillmentRepository {
  // ---- shipments ----

  /** Every shipment of these orders, cancelled ones too. */
  async shipmentsOf(tx: Tx, orderIds: string[]): Promise<ShipmentRow[]> {
    if (orderIds.length === 0) return [];
    return tx.select().from(shipment).where(inArray(shipment.orderId, orderIds));
  }

  /** Deletes shipments with their packages (ON DELETE CASCADE). */
  async deleteShipments(tx: Tx, ids: string[]): Promise<void> {
    if (ids.length > 0) await tx.delete(shipment).where(inArray(shipment.id, ids));
  }

  /** PDF files of documents that printed any of these orders. */
  async documentFilesFor(tx: Tx, orderIds: string[]): Promise<string[]> {
    if (orderIds.length === 0) return [];
    const rows = await tx
      .select({ fileId: documentJob.fileObjectId })
      .from(documentJob)
      .where(
        and(
          isNotNull(documentJob.fileObjectId),
          sql`jsonb_exists_any(${documentJob.params} -> 'orderIds', ARRAY[${sql.join(
            orderIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[])`,
        ),
      );
    return rows.map((r) => r.fileId!);
  }

  /**
   * Shipments with a rule's print instruction whose label is ready (label ready, or packed already), locked
   * and skipping rows another print job holds (FR-SHP-18).
   */
  async autoPrintDue(tx: Tx, limit: number): Promise<ShipmentRow[]> {
    return tx
      .select()
      .from(shipment)
      .where(and(isNotNull(shipment.autoPrint), inArray(shipment.status, ["label_ready", "packed"])))
      .orderBy(asc(shipment.id))
      .limit(limit)
      .for("update", { skipLocked: true });
  }

  /** Whether a labels document holding this order was requested at or after `since` and still stands. */
  async labelsDocumentSince(tx: Tx, orderId: string, since: Date): Promise<boolean> {
    const [r] = await tx
      .select({ id: documentJob.id })
      .from(documentJob)
      .where(
        and(
          eq(documentJob.kind, "labels"),
          inArray(documentJob.status, ["queued", "running", "ready"]),
          gte(documentJob.createdAt, since),
          sql`${documentJob.params} -> 'orderIds' ? ${orderId}`,
        ),
      )
      .limit(1);
    return !!r;
  }

  /** The live (not cancelled) shipment of each order. */
  async liveFor(tx: Tx, orderIds: string[], forUpdate = false): Promise<ShipmentRow[]> {
    if (orderIds.length === 0) return [];
    const q = tx
      .select()
      .from(shipment)
      .where(and(inArray(shipment.orderId, orderIds), ne(shipment.status, "cancelled")))
      .orderBy(asc(shipment.id));
    return forUpdate ? q.for("update") : q;
  }

  /** Every shipment of these orders, cancelled ones too, newest first. */
  async ofOrders(tx: Tx, orderIds: string[]): Promise<ShipmentRow[]> {
    if (orderIds.length === 0) return [];
    return tx.select().from(shipment).where(inArray(shipment.orderId, orderIds)).orderBy(desc(shipment.id));
  }

  async getMany(tx: Tx, ids: string[], forUpdate = false): Promise<ShipmentRow[]> {
    if (ids.length === 0) return [];
    const q = tx.select().from(shipment).where(inArray(shipment.id, ids)).orderBy(asc(shipment.id));
    return forUpdate ? q.for("update") : q;
  }

  /** Null when the order already has a live shipment (the partial unique index). */
  async insertShipment(tx: Tx, row: typeof shipment.$inferInsert): Promise<ShipmentRow | undefined> {
    const [r] = await tx
      .insert(shipment)
      .values(row)
      .onConflictDoNothing({ target: [shipment.tenantId, shipment.orderId], where: sql`status <> 'cancelled'` })
      .returning();
    return r;
  }

  async updateShipment(tx: Tx, id: string, patch: Partial<typeof shipment.$inferInsert>): Promise<void> {
    if (Object.keys(patch).length > 0) await tx.update(shipment).set(patch).where(eq(shipment.id, id));
  }

  /** Orders whose live shipment, or one of its packages, carries one of these tracking numbers. */
  async orderIdsByTracking(tx: Tx, codes: string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    const live = ne(shipment.status, "cancelled");
    const direct = await tx
      .select({ orderId: shipment.orderId })
      .from(shipment)
      .where(and(inArray(shipment.trackingNumber, codes), live));
    const viaPackage = await tx
      .select({ orderId: shipment.orderId })
      .from(shipmentPackage)
      .innerJoin(shipment, eq(shipment.id, shipmentPackage.shipmentId))
      .where(and(inArray(shipmentPackage.trackingNumber, codes), live));
    return [...new Set([...direct, ...viaPackage].map((r) => r.orderId))];
  }

  /** Shipments packed with their label and not handed over yet (waiting for a courier, FR-SHP-05). */
  async packedShipments(tx: Tx, limit: number): Promise<ShipmentRow[]> {
    return tx.select().from(shipment).where(eq(shipment.status, "packed")).orderBy(asc(shipment.id)).limit(limit);
  }

  // ---- packages ----

  /**
   * Tracking descriptions of these shipments emptied (backend doc 8.34): they may name who received the
   * parcel. Times, codes, and stages stay, so the timeline keeps its shape.
   */
  async clearTrackingDescriptions(tx: Tx, shipmentIds: string[]): Promise<void> {
    if (shipmentIds.length === 0) return;
    const events = sql.raw(`"shipment"."tracking_events"`);
    await tx
      .update(shipment)
      .set({
        trackingEvents: sql`(SELECT coalesce(jsonb_agg(e || '{"description": ""}'::jsonb ORDER BY n), '[]'::jsonb)
          FROM jsonb_array_elements(${events}) WITH ORDINALITY AS t(e, n))`,
      })
      .where(and(inArray(shipment.id, shipmentIds), sql`${events} <> '[]'::jsonb`));
  }

  async packages(tx: Tx, shipmentIds: string[]): Promise<PackageRow[]> {
    if (shipmentIds.length === 0) return [];
    return tx
      .select()
      .from(shipmentPackage)
      .where(inArray(shipmentPackage.shipmentId, shipmentIds))
      .orderBy(asc(shipmentPackage.id));
  }

  async insertPackage(tx: Tx, row: typeof shipmentPackage.$inferInsert): Promise<void> {
    await tx.insert(shipmentPackage).values(row);
  }

  async updatePackage(tx: Tx, id: string, patch: Partial<typeof shipmentPackage.$inferInsert>): Promise<void> {
    if (Object.keys(patch).length > 0) await tx.update(shipmentPackage).set(patch).where(eq(shipmentPackage.id, id));
  }

  /** Packages still without a label, of shipments in these statuses. */
  async withoutLabel(tx: Tx, shipmentIds: string[]): Promise<PackageRow[]> {
    if (shipmentIds.length === 0) return [];
    return tx
      .select()
      .from(shipmentPackage)
      .where(and(inArray(shipmentPackage.shipmentId, shipmentIds), isNull(shipmentPackage.labelFileId)))
      .orderBy(asc(shipmentPackage.id));
  }

  // ---- documents ----

  async insertDocument(tx: Tx, row: typeof documentJob.$inferInsert): Promise<DocumentRow> {
    const [r] = await tx.insert(documentJob).values(row).returning();
    return r!;
  }

  async getDocument(tx: Tx, id: string, forUpdate = false): Promise<DocumentRow | undefined> {
    const q = tx.select().from(documentJob).where(eq(documentJob.id, id));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async updateDocument(tx: Tx, id: string, patch: Partial<typeof documentJob.$inferInsert>): Promise<void> {
    if (Object.keys(patch).length > 0) await tx.update(documentJob).set(patch).where(eq(documentJob.id, id));
  }

  // ---- label template (FR-SHP-16) ----

  /** The business's custom template; one row per business at most. */
  async labelTemplate(tx: Tx): Promise<LabelTemplateRow | undefined> {
    const [r] = await tx.select().from(labelTemplate).limit(1);
    return r;
  }

  async saveLabelTemplate(tx: Tx, row: typeof labelTemplate.$inferInsert): Promise<void> {
    const { id: _, tenantId: __, ...set } = row;
    await tx.insert(labelTemplate).values(row).onConflictDoUpdate({ target: labelTemplate.tenantId, set });
  }

  /** Shipments in id order (full data export, FR-MIG-09). */
  async shipmentsPage(tx: Tx, after: string | undefined, limit: number): Promise<ShipmentRow[]> {
    return tx
      .select()
      .from(shipment)
      .where(after ? gt(shipment.id, after) : undefined)
      .orderBy(asc(shipment.id))
      .limit(limit);
  }
}
