import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { type ExportSheet, singlePage } from "../../common/export-sheet";
import type { DbHandle, Tx } from "../../db/client";
import { type WarehouseAddress, warehouse } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { warehouseMissing } from "./inventory.errors";

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  active: boolean;
  address: WarehouseAddress;
  rowVersion: number;
  createdAt: Date;
}

const columns = {
  id: warehouse.id,
  code: warehouse.code,
  name: warehouse.name,
  isDefault: warehouse.isDefault,
  active: warehouse.active,
  address: warehouse.address,
  rowVersion: warehouse.rowVersion,
  createdAt: warehouse.createdAt,
};

/** One line of a warehouse address: street, district, city, province, postal code. */
export function addressLine(a: WarehouseAddress): string {
  return [a.line1, a.district, a.city, a.province, a.postalCode].filter((v) => v?.trim()).join(", ");
}

/**
 * Warehouses the inventory module owns (backend doc 7.8.4, 11). Other modules use this service instead
 * of querying `warehouse`. Reads respect the caller's warehouse scope; the writes below are called by
 * WarehouseAdminService, which checks what else uses a warehouse. Signup creates the first one.
 */
@Injectable()
export class WarehousesService {
  constructor(@Inject(DB_TENANT) private readonly db: DbHandle) {}

  /** Warehouses the caller may see: all, or only those in the caller's warehouse scope. */
  async list(ctx: RequestContext): Promise<WarehouseView[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const scope = ctx.warehouseScope;
      if (scope && scope.size === 0) return [];
      return tx
        .select(columns)
        .from(warehouse)
        .where(and(isNull(warehouse.deletedAt), scope ? inArray(warehouse.id, [...scope]) : undefined))
        .orderBy(desc(warehouse.isDefault), asc(warehouse.name));
    });
  }

  /** One warehouse the caller may see (not deleted), or 404. */
  async get(ctx: RequestContext, id: string): Promise<WarehouseView> {
    return withTenantTx(this.db, ctx, (tx) => this.visibleOneIn(tx, ctx, id));
  }

  async visibleOneIn(tx: Tx, ctx: RequestContext, id: string, forUpdate = false): Promise<WarehouseView> {
    if (ctx.warehouseScope && !ctx.warehouseScope.has(id)) throw warehouseMissing();
    const q = tx
      .select(columns)
      .from(warehouse)
      .where(and(eq(warehouse.id, id), isNull(warehouse.deletedAt)));
    const [row] = forUpdate ? await q.for("update") : await q;
    if (!row) throw warehouseMissing();
    return row;
  }

  /** Active warehouses the caller may work with (warehouse scope, FR-WHS-09), inside a transaction. */
  async visibleIn(tx: Tx, ctx: RequestContext): Promise<WarehouseView[]> {
    const scope = ctx.warehouseScope;
    if (scope && scope.size === 0) return [];
    return tx
      .select(columns)
      .from(warehouse)
      .where(
        and(
          eq(warehouse.active, true),
          isNull(warehouse.deletedAt),
          scope ? inArray(warehouse.id, [...scope]) : undefined,
        ),
      )
      .orderBy(desc(warehouse.isDefault), asc(warehouse.name));
  }

  /** Active, not deleted warehouses, inside an existing transaction. */
  async activeIn(tx: Tx): Promise<WarehouseView[]> {
    return tx
      .select(columns)
      .from(warehouse)
      .where(and(eq(warehouse.active, true), isNull(warehouse.deletedAt)))
      .orderBy(desc(warehouse.isDefault), asc(warehouse.name));
  }

  async findActiveIn(tx: Tx, id: string): Promise<WarehouseView | undefined> {
    const [row] = await tx
      .select(columns)
      .from(warehouse)
      .where(and(eq(warehouse.id, id), eq(warehouse.active, true), isNull(warehouse.deletedAt)));
    return row;
  }

  // ---- writes, for WarehouseAdminService (backend doc 8.21) ----

  /** Codes stay taken after a warehouse is deleted: exports and stock cards keep naming it. */
  async codeTakenIn(tx: Tx, code: string, exceptId?: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: warehouse.id })
      .from(warehouse)
      .where(and(eq(warehouse.code, code), exceptId ? ne(warehouse.id, exceptId) : undefined));
    return !!row;
  }

  async insertIn(tx: Tx, row: typeof warehouse.$inferInsert): Promise<void> {
    await tx.insert(warehouse).values(row);
  }

  /** False when `expectedRowVersion` no longer matches (8.8). */
  async updateIn(
    tx: Tx,
    id: string,
    patch: Partial<typeof warehouse.$inferInsert>,
    expectedRowVersion?: number,
  ): Promise<boolean> {
    const r = await tx
      .update(warehouse)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${warehouse.rowVersion} + 1` })
      .where(
        and(
          eq(warehouse.id, id),
          expectedRowVersion === undefined ? undefined : eq(warehouse.rowVersion, expectedRowVersion),
        ),
      )
      .returning({ id: warehouse.id });
    return r.length > 0;
  }

  /** Clears the default flag first: the partial unique index allows one default at a time. */
  async clearDefaultIn(tx: Tx): Promise<void> {
    await tx
      .update(warehouse)
      .set({ isDefault: false, updatedAt: new Date(), rowVersion: sql`${warehouse.rowVersion} + 1` })
      .where(eq(warehouse.isDefault, true));
  }

  // ---- full data export (FR-MIG-09) ----

  /** Every warehouse, deleted ones included: codes for the other export sheets. */
  async codesIn(tx: Tx): Promise<Map<string, string>> {
    const rows = await tx.select({ id: warehouse.id, code: warehouse.code }).from(warehouse);
    return new Map(rows.map((r) => [r.id, r.code]));
  }

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "gudang.csv",
        description: "Gudang OmniSeller, termasuk yang sudah dihapus.",
        columns: [
          "id",
          "kode",
          "nama",
          "alamat",
          "kecamatan",
          "kota",
          "provinsi",
          "kode_pos",
          "kontak",
          "telepon",
          "gudang_utama",
          "aktif",
          "dihapus_pada",
          "dibuat_pada",
        ],
        pages: (tx) =>
          singlePage(async () =>
            (await tx.select().from(warehouse).orderBy(asc(warehouse.code))).map((w) => [
              w.id,
              w.code,
              w.name,
              w.address.line1,
              w.address.district,
              w.address.city,
              w.address.province,
              w.address.postalCode,
              w.address.contactName,
              w.address.phone,
              w.isDefault,
              w.active,
              w.deletedAt,
              w.createdAt,
            ]),
          ),
      },
    ];
  }
}
