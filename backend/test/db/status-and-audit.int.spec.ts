import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { toProblem } from "../../src/common/errors/problem";
import { withStatusSource, withTenantTx } from "../../src/db/tenant-tx";
import {
  createOrder,
  createProductWithVariant,
  createStore,
  createTenant,
  type TenantFixture,
} from "../setup/factories";
import { testHandles } from "../setup/handles";

const h = testHandles();

describe("status machine on the partitioned order table (invariant I3)", () => {
  let t: TenantFixture;
  let storeId: string;

  beforeAll(async () => {
    t = await createTenant(h.api);
    storeId = await withTenantTx(h.api, t.ctx, (tx) => createStore(tx, t.tenantId));
  });

  const setStatus = (orderId: string, to: string) =>
    withTenantTx(h.api, t.ctx, (tx) => tx.execute(sql`UPDATE "order" SET status = ${to} WHERE id = ${orderId}`));

  const statusOf = (orderId: string) =>
    withTenantTx(
      h.api,
      t.ctx,
      async (tx) =>
        (
          await tx.execute<{ status: string; status_changed_at: string; row_version: number }>(
            sql`SELECT status, status_changed_at, row_version FROM "order" WHERE id = ${orderId}`,
          )
        ).rows[0]!,
    );

  it("allows seller-side transitions and records when the status changed", async () => {
    const orderId = await withTenantTx(h.api, t.ctx, (tx) => createOrder(tx, t.tenantId, storeId));
    const before = await statusOf(orderId);
    await setStatus(orderId, "ready_to_pack");
    await setStatus(orderId, "packed");
    const after = await statusOf(orderId);
    expect(after.status).toBe("packed");
    // raw execute() returns timestamptz as text (Drizzle leaves dates to its column mappers)
    expect(new Date(after.status_changed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.status_changed_at).getTime(),
    );
    expect(after.row_version).toBe(before.row_version + 2);
  });

  it("rejects transitions that are not in the table", async () => {
    const orderId = await withTenantTx(h.api, t.ctx, (tx) => createOrder(tx, t.tenantId, storeId));
    const err = await setStatus(orderId, "completed").catch((e) => e);
    expect(toProblem(err, "R")).toMatchObject({ status: 409, code: "status.invalid_transition" });
    expect(err.cause?.detail).toContain("order: new -> completed (source app)");
  });

  it("allows marketplace facts to skip seller steps only when declared", async () => {
    const orderId = await withTenantTx(h.api, t.ctx, (tx) =>
      createOrder(tx, t.tenantId, storeId, { status: "ready_to_pack" }),
    );
    await expect(setStatus(orderId, "shipped")).rejects.toBeDefined();
    await withTenantTx(h.worker, t.ctx, (tx) =>
      withStatusSource(tx, "marketplace", () =>
        tx.execute(sql`UPDATE "order" SET status = 'shipped' WHERE id = ${orderId}`),
      ),
    );
    expect((await statusOf(orderId)).status).toBe("shipped");
  });

  it("resets the status source after the marketplace block", async () => {
    const o1 = await withTenantTx(h.api, t.ctx, (tx) => createOrder(tx, t.tenantId, storeId));
    const o2 = await withTenantTx(h.api, t.ctx, (tx) => createOrder(tx, t.tenantId, storeId));
    const err = await withTenantTx(h.worker, t.ctx, async (tx) => {
      await withStatusSource(tx, "marketplace", () =>
        tx.execute(sql`UPDATE "order" SET status = 'shipped' WHERE id = ${o1}`),
      );
      return tx.execute(sql`UPDATE "order" SET status = 'shipped' WHERE id = ${o2}`);
    }).catch((e) => e);
    expect(toProblem(err, "R").code).toBe("status.invalid_transition");
  });

  it("ignores updates that keep the same status", async () => {
    const orderId = await withTenantTx(h.api, t.ctx, (tx) => createOrder(tx, t.tenantId, storeId));
    await setStatus(orderId, "new");
    expect((await statusOf(orderId)).status).toBe("new");
  });

  it("keeps the business key unique across partitions via order_external_ref", async () => {
    const err = await withTenantTx(h.api, t.ctx, async (tx) => {
      const id = await createOrder(tx, t.tenantId, storeId);
      const ref = await tx.execute<{ external_order_id: string }>(
        sql`SELECT external_order_id FROM order_external_ref WHERE order_id = ${id}`,
      );
      await tx.execute(sql`INSERT INTO order_external_ref (id, tenant_id, store_id, external_order_id, order_id)
                           VALUES (${newId()}, ${t.tenantId}, ${storeId}, ${ref.rows[0]!.external_order_id}, ${id})`);
    }).catch((e) => e);
    expect(toProblem(err, "R")).toMatchObject({ status: 409 });
  });
});

describe("composite foreign keys with ON DELETE SET NULL (backend doc 7.4)", () => {
  it("clears only the reference column and keeps tenant_id", async () => {
    const t = await createTenant(h.api);
    const { shipmentId, fileId } = await withTenantTx(h.api, t.ctx, async (tx) => {
      const storeId = await createStore(tx, t.tenantId);
      const orderId = await createOrder(tx, t.tenantId, storeId);
      const fileId = newId();
      const shipmentId = newId();
      await tx.execute(sql`INSERT INTO file_object (id, tenant_id, bucket, object_key, mime, size_bytes, purpose, expires_at)
                           VALUES (${fileId}, ${t.tenantId}, 'labels', ${`l/${fileId}.pdf`}, 'application/pdf', 1024, 'label', now())`);
      await tx.execute(
        sql`INSERT INTO shipment (id, tenant_id, order_id, label_file_id) VALUES (${shipmentId}, ${t.tenantId}, ${orderId}, ${fileId})`,
      );
      return { shipmentId, fileId };
    });
    // files.cleanup_expired deletes expired label files; the shipment must survive with a NULL label
    await withTenantTx(h.worker, t.ctx, (tx) => tx.execute(sql`DELETE FROM file_object WHERE id = ${fileId}`));
    const row = await withTenantTx(
      h.api,
      t.ctx,
      async (tx) =>
        (
          await tx.execute<{ tenant_id: string; label_file_id: string | null }>(
            sql`SELECT tenant_id, label_file_id FROM shipment WHERE id = ${shipmentId}`,
          )
        ).rows[0],
    );
    expect(row).toEqual({ tenant_id: t.tenantId, label_file_id: null });
  });
});

describe("audit (backend doc 7.7)", () => {
  it("writes one row per changed row with its own id, even for multi-row statements", async () => {
    const t = await createTenant(h.api);
    const variants = await withTenantTx(h.api, t.ctx, async (tx) => [
      (await createProductWithVariant(tx, t.tenantId)).variantId,
      (await createProductWithVariant(tx, t.tenantId)).variantId,
      (await createProductWithVariant(tx, t.tenantId)).variantId,
    ]);
    await withTenantTx(h.api, t.ctx, (tx) => tx.execute(sql`UPDATE variant SET base_price = base_price + 1000`));
    const rows = await withTenantTx(
      h.api,
      t.ctx,
      async (tx) =>
        (
          await tx.execute<{
            id: string;
            entity_id: string;
            actor_type: string;
            actor_id: string;
            request_id: string;
            action: string;
          }>(
            sql`SELECT id, entity_id, actor_type, actor_id, request_id, action FROM audit_log
             WHERE entity_type = 'variant' AND action = 'update' ORDER BY id`,
          )
        ).rows,
    );
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(new Set(rows.map((r) => r.entity_id))).toEqual(new Set(variants));
    expect(rows[0]).toMatchObject({ actor_type: "user", actor_id: t.ctx.actor.id, request_id: t.ctx.requestId });
  });

  it("does not audit sync-only columns, and the log cannot be changed", async () => {
    const t = await createTenant(h.api);
    const variantId = await withTenantTx(
      h.api,
      t.ctx,
      async (tx) => (await createProductWithVariant(tx, t.tenantId)).variantId,
    );
    await withTenantTx(h.api, t.ctx, (tx) =>
      tx.execute(sql`UPDATE variant SET weight_g = 250 WHERE id = ${variantId}`),
    );
    const count = await withTenantTx(h.api, t.ctx, async (tx) =>
      Number(
        (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'update'`))
          .rows[0]!.n,
      ),
    );
    expect(count).toBe(0);
    const system = await h.raw("system");
    await expect(system.query("DELETE FROM audit_log WHERE tenant_id = $1", [t.tenantId])).rejects.toMatchObject({
      message: "AUDIT_LOG_IMMUTABLE",
    });
  });
});
