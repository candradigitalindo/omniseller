import { newId, PERMISSION_CODES } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import type { RequestContext } from "../../src/common/context/request-context";
import type { DbHandle, Tx } from "../../src/db/client";
import { withTenantTx } from "../../src/db/tenant-tx";

/**
 * Test data factories (backend doc 13.2). Everything is created through the omniseller_api role
 * inside withTenantTx, so factories themselves prove that RLS allows the normal paths.
 * Personal data is always fake.
 */

export function userCtx(tenantId: string, userId = newId()): RequestContext {
  const requestId = newId();
  return {
    requestId,
    traceId: requestId,
    tenantId,
    actor: { type: "user", id: userId },
    permissions: new Set(PERMISSION_CODES),
    storeScope: null,
    warehouseScope: null,
    locale: "id",
  };
}

export interface TenantFixture {
  tenantId: string;
  ctx: RequestContext;
}

export async function createTenant(
  api: DbHandle,
  slug = `t-${newId().slice(-10).toLowerCase()}`,
): Promise<TenantFixture> {
  const tenantId = newId();
  const ctx = userCtx(tenantId);
  await withTenantTx(api, ctx, async (tx) => {
    const plan = await tx.execute<{ id: string }>(sql`SELECT id FROM plan WHERE code = 'starter'`);
    await tx.execute(sql`INSERT INTO tenant (id, name, slug, plan_id)
                         VALUES (${tenantId}, ${`Toko ${slug}`}, ${slug}, ${plan.rows[0]!.id})`);
  });
  return { tenantId, ctx };
}

export async function createWarehouse(tx: Tx, tenantId: string, code = `WH-${newId().slice(-6)}`): Promise<string> {
  const id = newId();
  await tx.execute(sql`INSERT INTO warehouse (id, tenant_id, code, name, address)
                       VALUES (${id}, ${tenantId}, ${code}, ${`Gudang ${code}`}, '{"city":"Jakarta"}')`);
  return id;
}

export async function createProductWithVariant(
  tx: Tx,
  tenantId: string,
  opts: { sku?: string; basePrice?: number; costPrice?: number } = {},
): Promise<{ productId: string; variantId: string }> {
  const productId = newId();
  const variantId = newId();
  const sku = opts.sku ?? `KAOS-${newId().slice(-8)}`;
  await tx.execute(
    sql`INSERT INTO product (id, tenant_id, name, sku) VALUES (${productId}, ${tenantId}, 'Kaos Polos Cotton 30s', ${sku})`,
  );
  await tx.execute(sql`INSERT INTO variant (id, tenant_id, product_id, sku, name, base_price, cost_price, weight_g)
                       VALUES (${variantId}, ${tenantId}, ${productId}, ${`${sku}-HTM-L`}, 'Hitam, L',
                               ${opts.basePrice ?? 65000}, ${opts.costPrice ?? 35000}, 200)`);
  return { productId, variantId };
}

export async function createStore(
  tx: Tx,
  tenantId: string,
  opts: { channel?: string; externalShopId?: string; warehouseId?: string } = {},
): Promise<string> {
  const id = newId();
  await tx.execute(sql`INSERT INTO store (id, tenant_id, channel, external_shop_id, name, status, default_warehouse_id)
                       VALUES (${id}, ${tenantId}, ${opts.channel ?? "shopee"}, ${opts.externalShopId ?? newId()},
                               'Toko Utama', 'active', ${opts.warehouseId ?? null})`);
  return id;
}

export async function createOrder(
  tx: Tx,
  tenantId: string,
  storeId: string,
  opts: { status?: string; warehouseId?: string } = {},
): Promise<string> {
  const id = newId();
  const externalId = `SP-${newId().slice(-10)}`;
  await tx.execute(sql`INSERT INTO "order" (id, tenant_id, store_id, channel, external_order_id, status, ordered_at,
                                            total, source, warehouse_id)
                       VALUES (${id}, ${tenantId}, ${storeId}, 'shopee', ${externalId}, ${opts.status ?? "new"}, now(),
                               245000, 'webhook', ${opts.warehouseId ?? null})`);
  await tx.execute(sql`INSERT INTO order_external_ref (id, tenant_id, store_id, external_order_id, order_id)
                       VALUES (${newId()}, ${tenantId}, ${storeId}, ${externalId}, ${id})`);
  return id;
}

export interface MovementInput {
  variantId: string;
  warehouseId: string;
  type: string;
  onHand?: number;
  reserved?: number;
  damaged?: number;
  buffer?: number;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
}

/** Calls the SQL entry points directly; InventoryService wraps exactly these two calls. */
export async function applyMovement(tx: Tx, tenantId: string, m: MovementInput) {
  await tx.execute(sql`SELECT ensure_inventory(${newId()}, ${tenantId}, ${m.variantId}, ${m.warehouseId})`);
  const r = await tx.execute<{
    on_hand_after: number;
    reserved_after: number;
    damaged_after: number;
    buffer_after: number;
    id: string;
  }>(sql`SELECT * FROM apply_stock_movement(
      ${newId()}, ${tenantId}, ${m.variantId}, ${m.warehouseId}, ${m.type},
      ${m.onHand ?? 0}, ${m.reserved ?? 0}, ${m.damaged ?? 0}, ${m.buffer ?? 0},
      ${m.referenceType ?? null}, ${m.referenceId ?? null}, ${m.reason ?? null}, NULL, NULL)`);
  return r.rows[0]!;
}
