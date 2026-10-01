import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { warehouse } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  active: boolean;
  address: Record<string, unknown>;
}

const columns = {
  id: warehouse.id,
  code: warehouse.code,
  name: warehouse.name,
  isDefault: warehouse.isDefault,
  active: warehouse.active,
  address: warehouse.address,
};

/**
 * Read side of the warehouses the inventory module owns (backend doc 11). Other modules use this
 * service instead of querying `warehouse`. Creating and editing warehouses arrives with the inventory
 * milestone; signup creates the first one.
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
}
