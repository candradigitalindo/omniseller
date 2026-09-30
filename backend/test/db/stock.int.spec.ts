import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { toProblem } from "../../src/common/errors/problem";
import { withTenantTx } from "../../src/db/tenant-tx";
import {
  applyMovement,
  createProductWithVariant,
  createTenant,
  createWarehouse,
  type TenantFixture,
} from "../setup/factories";
import { testHandles } from "../setup/handles";

const h = testHandles();

describe("stock changes only through apply_stock_movement (invariant I2)", () => {
  let t: TenantFixture;
  let variantId: string;
  let warehouseId: string;

  beforeAll(async () => {
    t = await createTenant(h.api);
    await withTenantTx(h.api, t.ctx, async (tx) => {
      warehouseId = await createWarehouse(tx, t.tenantId, "WH-JKT");
      variantId = (await createProductWithVariant(tx, t.tenantId)).variantId;
    });
  });

  const inv = () =>
    withTenantTx(h.api, t.ctx, async (tx) => {
      const r = await tx.execute<{ on_hand: number; reserved: number; buffer: number; available: number }>(
        sql`SELECT on_hand, reserved, buffer, available FROM inventory WHERE variant_id = ${variantId} AND warehouse_id = ${warehouseId}`,
      );
      return r.rows[0]!;
    });

  it("applies receipt, reservation, buffer, and shipment with a ledger of running balances", async () => {
    await withTenantTx(h.worker, t.ctx, async (tx) => {
      const receipt = await applyMovement(tx, t.tenantId, {
        variantId,
        warehouseId,
        type: "purchase_receipt",
        onHand: 10,
        referenceType: "manual",
      });
      expect(receipt).toMatchObject({ on_hand_after: 10, reserved_after: 0 });
      await applyMovement(tx, t.tenantId, {
        variantId,
        warehouseId,
        type: "order_reserve",
        reserved: 3,
        referenceType: "order_item",
        referenceId: newId(),
      });
      await applyMovement(tx, t.tenantId, {
        variantId,
        warehouseId,
        type: "campaign_hold",
        buffer: 2,
        referenceType: "manual",
      });
      const ship = await applyMovement(tx, t.tenantId, {
        variantId,
        warehouseId,
        type: "order_ship",
        onHand: -3,
        reserved: -3,
        referenceType: "order_item",
        referenceId: newId(),
      });
      expect(ship).toMatchObject({ on_hand_after: 7, reserved_after: 0, buffer_after: 2 });
    });
    expect(await inv()).toEqual({ on_hand: 7, reserved: 0, buffer: 2, available: 5 });

    const ledger = await withTenantTx(
      h.api,
      t.ctx,
      async (tx) =>
        (
          await tx.execute<{ type: string; on_hand_after: number }>(
            sql`SELECT type, on_hand_after FROM stock_movement WHERE variant_id = ${variantId} ORDER BY id`,
          )
        ).rows,
    );
    expect(ledger.map((r) => r.type)).toEqual(["purchase_receipt", "order_reserve", "campaign_hold", "order_ship"]);
  });

  it("lets available go negative as the overselling signal, but never on_hand or reserved", async () => {
    await withTenantTx(h.worker, t.ctx, (tx) =>
      applyMovement(tx, t.tenantId, {
        variantId,
        warehouseId,
        type: "order_reserve",
        reserved: 9,
        referenceType: "order_item",
        referenceId: newId(),
      }),
    );
    expect((await inv()).available).toBe(-4);
    const err = await withTenantTx(h.worker, t.ctx, (tx) =>
      applyMovement(tx, t.tenantId, {
        variantId,
        warehouseId,
        type: "order_ship",
        onHand: -100,
        reserved: -9,
        referenceType: "order_item",
        referenceId: newId(),
      }),
    ).catch((e) => e);
    expect(toProblem(err, "R")).toMatchObject({ status: 409, code: "stock.insufficient" });
    await withTenantTx(h.worker, t.ctx, (tx) =>
      applyMovement(tx, t.tenantId, {
        variantId,
        warehouseId,
        type: "order_release",
        reserved: -9,
        referenceType: "order_item",
        referenceId: newId(),
      }),
    );
  });

  it("requires a reason for manual adjustments", async () => {
    const err = await withTenantTx(h.api, t.ctx, (tx) =>
      applyMovement(tx, t.tenantId, {
        variantId,
        warehouseId,
        type: "adjustment",
        onHand: -1,
        referenceType: "manual",
      }),
    ).catch((e) => e);
    expect(toProblem(err, "R")).toMatchObject({ status: 422, code: "validation.failed" });
    await withTenantTx(h.api, t.ctx, (tx) =>
      applyMovement(tx, t.tenantId, {
        variantId,
        warehouseId,
        type: "adjustment",
        onHand: -1,
        reason: "rusak",
        referenceType: "manual",
      }),
    );
  });

  it("refuses to move stock of another tenant even though the function bypasses RLS", async () => {
    const other = await createTenant(h.api);
    const err = await withTenantTx(h.api, other.ctx, (tx) =>
      tx.execute(sql`SELECT * FROM apply_stock_movement(${newId()}, ${t.tenantId}, ${variantId}, ${warehouseId},
                     'adjustment', 5, 0, 0, 0, 'manual', NULL, 'x', NULL, NULL)`),
    ).catch((e) => e);
    expect(toProblem(err, "R")).toMatchObject({ status: 500, code: "internal.tenant_mismatch" });
  });

  it("blocks direct quantity updates even for the system role, but allows bin location edits", async () => {
    const system = await h.raw("system");
    await expect(
      system.query("UPDATE inventory SET on_hand = 999 WHERE variant_id = $1", [variantId]),
    ).rejects.toMatchObject({
      message: "INVENTORY_DIRECT_WRITE_FORBIDDEN",
    });
    await withTenantTx(h.api, t.ctx, (tx) =>
      tx.execute(sql`UPDATE inventory SET bin_location = 'A-01-03' WHERE variant_id = ${variantId}`),
    );
    const row = await withTenantTx(
      h.api,
      t.ctx,
      async (tx) =>
        (
          await tx.execute<{ bin_location: string }>(
            sql`SELECT bin_location FROM inventory WHERE variant_id = ${variantId}`,
          )
        ).rows[0],
    );
    expect(row?.bin_location).toBe("A-01-03");
  });

  it("serializes concurrent movements on the same row (no lost update)", async () => {
    const before = (await inv()).reserved;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withTenantTx(h.worker, t.ctx, (tx) =>
          applyMovement(tx, t.tenantId, {
            variantId,
            warehouseId,
            type: "order_reserve",
            reserved: 1,
            referenceType: "order_item",
            referenceId: newId(),
          }),
        ),
      ),
    );
    expect((await inv()).reserved).toBe(before + 10);
    const afters = await withTenantTx(h.api, t.ctx, async (tx) =>
      (
        await tx.execute<{ reserved_after: number }>(
          sql`SELECT reserved_after FROM stock_movement WHERE variant_id = ${variantId} AND type = 'order_reserve' ORDER BY id DESC LIMIT 10`,
        )
      ).rows
        .map((r) => r.reserved_after)
        .sort((x, y) => x - y),
    );
    expect(afters).toEqual(Array.from({ length: 10 }, (_, i) => before + i + 1));
  });
});
