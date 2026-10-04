import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { ConflictError } from "../../common/errors/domain-errors";
import { provinceOf } from "../../common/region";
import type { DbHandle } from "../../db/client";
import type { WarehouseAddress } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { StoresService } from "../channel/stores.service";
import { OrdersService } from "../orders/orders.service";
import {
  warehouseCodeTaken,
  warehouseHasOrders,
  warehouseHasStock,
  warehouseInUse,
  warehouseIsDefault,
} from "./inventory.errors";
import { InventoryRepository } from "./inventory.repository";
import { WarehousesService, type WarehouseView } from "./warehouses.service";

export interface WarehouseInput {
  code: string;
  name: string;
  address: WarehouseAddress;
}

/** The address as stored: trimmed, empty parts left out, a known province under its canonical name. */
export function cleanAddress(a: WarehouseAddress): WarehouseAddress {
  const out: WarehouseAddress = {};
  for (const [k, v] of Object.entries(a) as [keyof WarehouseAddress, string | undefined][]) {
    const t = v?.trim();
    if (t) out[k] = t;
  }
  if (out.province) out.province = provinceOf(out.province)?.name ?? out.province;
  return out;
}

const uniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return (e.code ?? e.cause?.code) === "23505";
};

/**
 * More than one physical warehouse (PRD 14 MVP-2, FR-STK-01, backend doc 8.21): add, change, make the
 * default, and delete. A warehouse is deleted (soft: `deleted_at`, inactive) only when nothing depends
 * on it: it is not the default, no store uses it as its default warehouse or through a mapped
 * marketplace warehouse, no order still has to ship from it, and it holds no stock. Codes stay taken
 * after deletion. Every change is in audit_log (trigger on `warehouse`).
 */
@Injectable()
export class WarehouseAdminService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(InventoryRepository) private readonly repo: InventoryRepository,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  async create(ctx: RequestContext, input: WarehouseInput & { isDefault?: boolean }): Promise<WarehouseView> {
    return this.codeChecked(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        if (await this.warehouses.codeTakenIn(tx, input.code)) throw warehouseCodeTaken();
        if (input.isDefault) await this.warehouses.clearDefaultIn(tx);
        const id = newId();
        await this.warehouses.insertIn(tx, {
          id,
          tenantId: ctx.tenantId,
          code: input.code,
          name: input.name,
          address: cleanAddress(input.address),
          isDefault: input.isDefault ?? false,
        });
        // a creator limited to some warehouses still gets what was created
        return this.warehouses.visibleOneIn(tx, { ...ctx, warehouseScope: null }, id);
      }),
    );
  }

  /** Code, name, address (replaced as a whole); `ifMatch` is the row version the caller saw. */
  async update(
    ctx: RequestContext,
    id: string,
    patch: Partial<WarehouseInput>,
    ifMatch?: number,
  ): Promise<WarehouseView> {
    return this.codeChecked(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        const current = await this.warehouses.visibleOneIn(tx, ctx, id, true);
        if (patch.code !== undefined && patch.code !== current.code) {
          if (await this.warehouses.codeTakenIn(tx, patch.code, id)) throw warehouseCodeTaken();
        }
        const ok = await this.warehouses.updateIn(
          tx,
          id,
          {
            ...(patch.code !== undefined ? { code: patch.code } : {}),
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.address !== undefined ? { address: cleanAddress(patch.address) } : {}),
          },
          ifMatch,
        );
        if (!ok) throw new ConflictError("row.stale", "Data sudah diubah orang lain. Muat ulang lalu coba lagi.");
        return this.warehouses.visibleOneIn(tx, ctx, id);
      }),
    );
  }

  /** The business's default warehouse: manual orders fall back to it, signup's first warehouse is one. */
  async makeDefault(ctx: RequestContext, id: string): Promise<WarehouseView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const w = await this.warehouses.visibleOneIn(tx, ctx, id, true);
      if (!w.isDefault) {
        await this.warehouses.clearDefaultIn(tx);
        await this.warehouses.updateIn(tx, id, { isDefault: true });
      }
      return this.warehouses.visibleOneIn(tx, ctx, id);
    });
  }

  async remove(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const w = await this.warehouses.visibleOneIn(tx, ctx, id, true);
      if (w.isDefault) throw warehouseIsDefault();
      const usage = await this.stores.warehouseUsageIn(tx, id);
      const stores = [...new Set([...usage.defaults.map((s) => s.name), ...usage.mappings.map((m) => m.storeName)])];
      if (stores.length > 0) throw warehouseInUse(stores);
      const orders = await this.orders.openInWarehouseIn(tx, id);
      if (orders > 0) throw warehouseHasOrders(orders);
      const held = await this.repo.heldIn(tx, id);
      if (held > 0) throw warehouseHasStock(held);
      await this.warehouses.updateIn(tx, id, { deletedAt: new Date(), active: false });
    });
  }

  private async codeChecked<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (uniqueViolation(err)) throw warehouseCodeTaken();
      throw err;
    }
  }
}
