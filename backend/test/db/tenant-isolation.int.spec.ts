import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { toProblem } from "../../src/common/errors/problem";
import { withTenantTx } from "../../src/db/tenant-tx";
import {
  createProductWithVariant,
  createStore,
  createTenant,
  createWarehouse,
  type TenantFixture,
} from "../setup/factories";
import { testHandles } from "../setup/handles";

const h = testHandles();

describe("tenant isolation (invariants I1, I6, ADR-003, ADR-025)", () => {
  let a: TenantFixture;
  let b: TenantFixture;
  let productA: string;
  let productB: string;

  beforeAll(async () => {
    a = await createTenant(h.api);
    b = await createTenant(h.api);
    productA = await withTenantTx(
      h.api,
      a.ctx,
      async (tx) => (await createProductWithVariant(tx, a.tenantId)).productId,
    );
    productB = await withTenantTx(
      h.api,
      b.ctx,
      async (tx) => (await createProductWithVariant(tx, b.tenantId)).productId,
    );
  });

  it("a tenant sees only its own rows", async () => {
    const seen = await withTenantTx(
      h.api,
      a.ctx,
      async (tx) => (await tx.execute<{ id: string }>(sql`SELECT id FROM product`)).rows,
    );
    expect(seen.map((r) => r.id)).toEqual([productA]);
    const tenants = await withTenantTx(h.api, a.ctx, async (tx) => (await tx.execute(sql`SELECT id FROM tenant`)).rows);
    expect(tenants).toEqual([{ id: a.tenantId }]);
  });

  it("returns zero rows, not all rows, when no tenant is set", async () => {
    const client = await h.raw("api");
    expect((await client.query("SELECT id FROM product")).rowCount).toBe(0);
    // also after a tenant transaction ended on the same session (setting becomes '' not NULL)
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
    expect((await client.query("SELECT id FROM product")).rowCount).toBe(1);
    await client.query("COMMIT");
    expect((await client.query("SELECT id FROM product")).rowCount).toBe(0);
  });

  it("rejects writing a row for another tenant (WITH CHECK)", async () => {
    const attempt = withTenantTx(h.api, a.ctx, (tx) =>
      tx.execute(sql`INSERT INTO product (id, tenant_id, name, sku) VALUES (${newId()}, ${b.tenantId}, 'x', 'X-1')`),
    );
    await expect(attempt).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("composite FKs make cross-tenant references impossible even for BYPASSRLS roles", async () => {
    const client = await h.raw("system");
    await expect(
      client.query(
        `INSERT INTO variant (id, tenant_id, product_id, sku, name, base_price, weight_g)
         VALUES ($1, $2, $3, 'X-L', 'x', 1, 1)`,
        [newId(), a.tenantId, productB],
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "variant_product_fk" });
  });

  it("one marketplace shop cannot be connected to two tenants", async () => {
    const shopId = `shop-${newId()}`;
    await withTenantTx(h.api, a.ctx, (tx) => createStore(tx, a.tenantId, { externalShopId: shopId }));
    const err = await withTenantTx(h.api, b.ctx, (tx) => createStore(tx, b.tenantId, { externalShopId: shopId })).catch(
      (e) => e,
    );
    expect(toProblem(err, "R")).toMatchObject({ status: 409, code: "store.already_connected" });
  });

  it("a nested transaction for another tenant is refused", async () => {
    const attempt = withTenantTx(h.api, a.ctx, () => withTenantTx(h.api, b.ctx, async () => 1));
    await expect(attempt).rejects.toMatchObject({ code: "internal.cross_tenant_tx" });
  });

  it("a nested transaction for the same tenant is a savepoint", async () => {
    const result = await withTenantTx(h.api, a.ctx, async (tx) => {
      await createWarehouse(tx, a.tenantId, "WH-OUTER");
      await withTenantTx(h.api, a.ctx, async (inner) => {
        await createWarehouse(inner, a.tenantId, "WH-INNER");
      }).catch(() => {});
      await withTenantTx(h.api, a.ctx, async (inner) => {
        await createWarehouse(inner, a.tenantId, "WH-ROLLED");
        throw new Error("roll back only the savepoint");
      }).catch(() => {});
      return (await tx.execute<{ code: string }>(sql`SELECT code FROM warehouse WHERE code LIKE 'WH-%' ORDER BY code`))
        .rows;
    });
    expect(result.map((r) => r.code)).toEqual(["WH-INNER", "WH-OUTER"]);
  });

  it("the RLS predicate can use tenant-leading indexes", async () => {
    const client = await h.raw("api");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
    await client.query("SET LOCAL enable_seqscan = off");
    const plan = await client.query("EXPLAIN SELECT id FROM variant WHERE product_id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'");
    await client.query("ROLLBACK");
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    // the tenant predicate injected by RLS must be an index condition, not a filter after the scan
    expect(text).toMatch(/Index (Only )?Scan using variant_tenant_product_idx/);
    expect(text).toMatch(/Index Cond: \(+\(?tenant_id\)?(::text)? = current_setting\('app\.tenant_id'/);
  });
});

describe("role privileges (invariants I2, I12, backend doc 7.5)", () => {
  let t: TenantFixture;

  beforeAll(async () => {
    t = await createTenant(h.api);
  });

  it("omniseller_api cannot read marketplace tokens; omniseller_worker can", async () => {
    const api = await h.raw("api");
    await expect(api.query("SELECT access_token_enc FROM store_credential")).rejects.toMatchObject({ code: "42501" });
    await expect(
      api.query("SELECT access_expires_at, refresh_fail_count FROM store_credential"),
    ).resolves.toBeDefined();
    await expect(
      api.query(
        "INSERT INTO store_credential (id, tenant_id, store_id, access_token_enc, dek_version) VALUES ($1,$2,$3,'\\x00',1)",
        [newId(), t.tenantId, newId()],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const worker = await h.raw("worker");
    await expect(worker.query("SELECT access_token_enc FROM store_credential")).resolves.toBeDefined();
  });

  it("partitions are unreachable except through their parent", async () => {
    const api = await h.raw("api");
    const part = await api.query<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relispartition AND relname LIKE 'order_p2%' ORDER BY relname LIMIT 1",
    );
    const name = part.rows[0]!.relname;
    await expect(api.query(`SELECT * FROM "${name}"`)).rejects.toMatchObject({ code: "42501" });
  });

  it("application roles cannot write the ledger, the audit log, or stock quantities directly", async () => {
    const worker = await h.raw("worker");
    await worker.query("BEGIN");
    await worker.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
    await expect(worker.query("UPDATE inventory SET on_hand = 1000")).rejects.toMatchObject({ code: "42501" });
    await worker.query("ROLLBACK");
    await expect(worker.query("DELETE FROM stock_movement")).rejects.toMatchObject({ code: "42501" });
    await expect(worker.query("DELETE FROM audit_log")).rejects.toMatchObject({ code: "42501" });
    await expect(worker.query("SELECT * FROM outbox_event")).rejects.toMatchObject({ code: "42501" });
  });

  it("SECURITY DEFINER lookups are not executable by roles that do not need them", async () => {
    const worker = await h.raw("worker");
    await expect(worker.query("SELECT * FROM auth_login_candidates('a@b.c')")).rejects.toMatchObject({ code: "42501" });
    // Xendit's callbacks arrive at the webhook process (api role); the worker is handed the tenant
    await expect(worker.query("SELECT * FROM billing_resolve_invoice('x')")).rejects.toMatchObject({ code: "42501" });
    const api = await h.raw("api");
    await expect(api.query("SELECT maintain_partitions(now())")).rejects.toMatchObject({ code: "42501" });
  });
});
