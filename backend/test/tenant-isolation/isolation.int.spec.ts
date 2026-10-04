import type { INestApplication } from "@nestjs/common";
import type { OpenAPIObject } from "@nestjs/swagger";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { buildOpenApiDocument } from "../../src/openapi/document";
import { type Client, type MeBody, signup, startApi, uniqueEmail } from "../setup/app";
import { createStore, userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace } from "../setup/mock-marketplace";

/**
 * Tenant isolation generator (backend doc 13.3). Every operation in the OpenAPI document must
 * declare `x-isolation`. For operations on tenant resources, a resource is created in tenant A and
 * the operation is called by tenant B's Owner (who has every permission, so a denial can only come
 * from isolation): by id it must answer 404, lists must not contain A's resource, and creates that
 * reference A's resources must be rejected.
 *
 * A new fixture kind or a new mutating operation without an entry below fails this test on purpose.
 */
const h = testHandles();

type Isolation = "public" | "self" | "global" | { fixture: string };

interface Fixture {
  /** id of tenant A's resource of this kind */
  id: string;
}

let app: INestApplication;
let doc: OpenAPIObject;
let marketplace: MockMarketplace;
/** Raw state of tenant A's pending store authorization (only the hash is stored). */
let aState = "";
let a: { c: Client; me: MeBody };
let b: { c: Client; me: MeBody };
const fixtures: Record<string, Fixture> = {};

/** Path parameters besides {id}, filled with A's fixture of the given kind. */
const PATH_PARAMS: Record<string, string> = {
  "{channelWarehouseId}": "channel_warehouse",
  "{variantId}": "variant",
  "{warehouseId}": "warehouse",
  "{problemId}": "order_problem",
};

/** Bodies for mutating operations, keyed by operationId. `ids` holds A's fixture ids and B's own ids. */
const BODIES: Record<string, (ids: { a: Record<string, string>; bViewerRoleId: string; aState: string }) => object> = {
  UsersController_update: () => ({ name: "Penyusup" }),
  UsersController_setRoles: ({ bViewerRoleId }) => ({ roleIds: [bViewerRoleId] }),
  UsersController_setScopes: () => ({ storeIds: null }),
  InvitationsController_create: ({ a: ids }) => ({ email: uniqueEmail("x"), roleId: ids.role! }),
  InvitationsController_resend: () => ({}),
  InvitationsController_revoke: () => ({}),
  StoreAuthorizationsController_start: ({ a: ids }) => ({ channel: "shopee", storeId: ids.store! }),
  StoreAuthorizationsController_callback: ({ aState: state }) => ({
    channel: "shopee",
    state,
    code: "c0de",
    shopId: "1",
  }),
  StoresController_update: () => ({ name: "Penyusup" }),
  StoresController_disconnect: () => ({}),
  StoresController_syncWarehouses: () => ({}),
  StoresController_mapChannelWarehouse: ({ a: ids }) => ({ warehouseId: ids.warehouse! }),
  ProductsController_update: () => ({ name: "Penyusup" }),
  ProductsController_remove: () => ({}),
  ProductsController_addVariant: () => ({ sku: "PENYUSUP-1", basePrice: 1, weightG: 1 }),
  ProductsController_updateVariant: () => ({ basePrice: 1 }),
  ListingsController_autoMap: ({ a: ids }) => ({ storeId: ids.store! }),
  ListingsController_createProducts: ({ a: ids }) => ({ listingIds: [ids.listing!] }),
  ListingsController_setStatus: ({ a: ids }) => ({ listingIds: [ids.listing!], active: false }),
  ListingsController_sync: ({ a: ids }) => ({ storeId: ids.store! }),
  ListingsController_map: ({ a: ids }) => ({ variantId: ids.variant! }),
  InventoryController_adjust: ({ a: ids }) => ({
    lines: [{ variantId: ids.variant!, warehouseId: ids.warehouse!, mode: "set", quantity: 1 }],
    reason: "correction",
  }),
  InventoryController_initialStock: ({ a: ids }) => ({ storeId: ids.store! }),
  InventoryController_resync: ({ a: ids }) => ({ storeId: ids.store! }),
  InventoryController_setLocation: () => ({ minStock: 1 }),
  StockRulesController_create: ({ a: ids }) => ({ storeId: ids.store!, mode: "all" }),
  StockRulesController_update: () => ({ value: 1 }),
  StockRulesController_remove: () => ({}),
  OrdersController_accept: ({ a: ids }) => ({ orderIds: [ids.order!] }),
  OrdersController_pack: ({ a: ids }) => ({ orderIds: [ids.order!] }),
  OrdersController_sync: ({ a: ids }) => ({ storeId: ids.store! }),
  OrdersController_cancel: () => ({ reason: "OUT_OF_STOCK" }),
  OrdersController_note: () => ({ note: "Penyusup" }),
  OrdersController_resolveProblem: () => ({}),
  ShipmentsController_arrange: ({ a: ids }) => ({ orderIds: [ids.order!], method: "pickup" }),
  ShipmentsController_labels: ({ a: ids }) => ({ orderIds: [ids.order!] }),
  DocumentsController_create: ({ a: ids }) => ({ kind: "labels", orderIds: [ids.order!] }),
  DocumentsController_pickList: ({ a: ids }) => ({ orderIds: [ids.order!] }),
  MigrationImportsController_setMapping: () => ({
    headerRow: 1,
    fields: { sku_varian: 0, nama_produk: 1, harga_dasar: 2, berat: 3 },
    weightUnit: "g",
    dimensionUnit: "cm",
  }),
  MigrationImportsController_validate: () => ({}),
  MigrationImportsController_import: () => ({}),
  MigrationImportsController_deletePreset: () => ({}),
  MigrationCutoverController_cutover: ({ a: ids }) => ({ storeIds: [ids.store!], oldAppRevoked: true }),
  MigrationCutoverController_undo: () => ({}),
};

beforeAll(async () => {
  marketplace = new MockMarketplace();
  await marketplace.start();
  app = await startApi(h.infra, { marketplace });
  doc = buildOpenApiDocument(app);
  a = await signup(app, { businessName: "Tenant A" });
  b = await signup(app, { businessName: "Tenant B" });

  const aRoles = (await a.c.get("/v1/roles")).body.items as { id: string; name: string }[];
  fixtures.user = { id: a.me.user.id };
  fixtures.role = { id: aRoles.find((r) => r.name === "Viewer")!.id };
  const invite = await a.c.post("/v1/invitations", { email: uniqueEmail("a"), roleId: fixtures.role.id });
  fixtures.invitation = { id: invite.body.id };
  const audit = await a.c.get("/v1/audit-logs?limit=1");
  fixtures.audit = { id: audit.body.items[0].id };

  const warehouses = (await a.c.get("/v1/warehouses")).body.items as { id: string }[];
  fixtures.warehouse = { id: warehouses[0]!.id };
  // A connected store and one of its marketplace warehouses, as the worker would have written them.
  const tenantId = a.me.tenant.id;
  await withTenantTx(h.worker, userCtx(tenantId), async (tx) => {
    const storeId = await createStore(tx, tenantId, { warehouseId: fixtures.warehouse!.id });
    fixtures.store = { id: storeId };
    const cwId = newId();
    await tx.execute(sql`INSERT INTO channel_warehouse (id, tenant_id, store_id, external_warehouse_id, name, kind, last_seen_at)
                         VALUES (${cwId}, ${tenantId}, ${storeId}, 'default', 'Gudang toko', 'seller', now())`);
    fixtures.channel_warehouse = { id: cwId };
  });
  const product = await a.c.post("/v1/products", {
    sku: "A-KAOS",
    name: "Kaos Tenant A",
    variants: [{ sku: "A-KAOS-1", basePrice: 50000, weightG: 200 }],
  });
  fixtures.product = { id: product.body.id };
  fixtures.variant = { id: product.body.variants[0].id };
  await withTenantTx(h.worker, userCtx(tenantId), async (tx) => {
    const listingId = newId();
    await tx.execute(sql`INSERT INTO channel_listing (id, tenant_id, store_id, external_item_id, external_sku, title, status)
                         VALUES (${listingId}, ${tenantId}, ${fixtures.store!.id}, '9001', 'A-KAOS-1', 'Kaos Tenant A', 'active')`);
    fixtures.listing = { id: listingId };
  });
  const adjusted = await a.c.post("/v1/inventory/adjustments", {
    lines: [{ variantId: fixtures.variant.id, warehouseId: fixtures.warehouse.id, mode: "set", quantity: 7 }],
    reason: "correction",
  });
  fixtures.stock_movement = { id: adjusted.body.items[0].movementId };
  const rule = await a.c.post("/v1/stock-allocation-rules", { storeId: fixtures.store!.id, mode: "all", buffer: 2 });
  expect(rule.status).toBe(201);
  fixtures.stock_rule = { id: rule.body.id };
  await withTenantTx(h.worker, userCtx(tenantId), async (tx) => {
    const orderId = newId();
    await tx.execute(sql`INSERT INTO "order" (id, tenant_id, store_id, channel, external_order_id, external_status, status,
                                               warehouse_id, ordered_at, total, source)
                         VALUES (${orderId}, ${tenantId}, ${fixtures.store!.id}, 'shopee', 'A-0001', 'READY_TO_SHIP', 'problem',
                                 ${fixtures.warehouse!.id}, now(), 50000, 'webhook')`);
    await tx.execute(sql`INSERT INTO order_external_ref (id, tenant_id, store_id, external_order_id, order_id)
                         VALUES (${newId()}, ${tenantId}, ${fixtures.store!.id}, 'A-0001', ${orderId})`);
    const problemId = newId();
    await tx.execute(sql`INSERT INTO order_problem (id, tenant_id, order_id, code, detail)
                         VALUES (${problemId}, ${tenantId}, ${orderId}, 'high_value', '{}')`);
    fixtures.order = { id: orderId };
    fixtures.order_problem = { id: problemId };
    // a label file and a printed document, as the worker would have written them
    const fileId = newId();
    await tx.execute(sql`INSERT INTO file_object (id, tenant_id, bucket, object_key, mime, size_bytes, purpose)
                         VALUES (${fileId}, ${tenantId}, 'local', ${`t/${tenantId}/label/${fileId}.pdf`}, 'application/pdf', 10, 'label')`);
    fixtures.file_object = { id: fileId };
    const documentId = newId();
    await tx.execute(sql`INSERT INTO document_job (id, tenant_id, kind, status, params, file_object_id, requested_by)
                         VALUES (${documentId}, ${tenantId}, 'labels', 'queued',
                                 ${JSON.stringify({ orderIds: [orderId], format: "thermal" })}::jsonb, ${fileId}, ${a.me.user.id})`);
    fixtures.document = { id: documentId };
    // a full data export being made (the worker is not running here)
    const exportId = newId();
    await tx.execute(
      sql`INSERT INTO data_export (id, tenant_id, requested_by) VALUES (${exportId}, ${tenantId}, ${a.me.user.id})`,
    );
    fixtures.data_export = { id: exportId };
    // an uploaded migration file, a saved column mapping, and a cutover of the store
    const migrationJobId = newId();
    const mapping = {
      headerRow: 1,
      fields: { sku_varian: 0, nama_produk: 1, harga_dasar: 2, berat: 3 },
      weightUnit: "g",
      dimensionUnit: "cm",
    };
    await tx.execute(sql`INSERT INTO migration_job (id, tenant_id, source_app, file_name, file_type, columns, column_mapping, stats, created_by)
                         VALUES (${migrationJobId}, ${tenantId}, 'bigseller', 'produk.xlsx', 'xlsx',
                                 '["SKU","Nama","Harga","Berat"]'::jsonb, ${JSON.stringify(mapping)}::jsonb, '{"rows":1}'::jsonb,
                                 ${a.me.user.id})`);
    fixtures.migration_job = { id: migrationJobId };
    const presetId = newId();
    await tx.execute(sql`INSERT INTO migration_preset (id, tenant_id, name, source_app, mapping)
                         VALUES (${presetId}, ${tenantId}, 'Preset A', 'bigseller',
                                 '{"fields":{"sku_varian":"SKU"},"weightUnit":"g","dimensionUnit":"cm"}'::jsonb)`);
    fixtures.migration_preset = { id: presetId };
    const cutoverId = newId();
    await tx.execute(sql`INSERT INTO store_cutover (id, tenant_id, store_id, checklist, undo_until)
                         VALUES (${cutoverId}, ${tenantId}, ${fixtures.store!.id},
                                 '{"checks":[],"oldAppRevoked":true,"stock":{"match":0,"differ":0,"unset":0}}'::jsonb,
                                 now() + interval '1 day')`);
    fixtures.store_cutover = { id: cutoverId };
  });
  const started = await a.c.post("/v1/store-authorizations", { channel: "shopee" });
  expect(started.status).toBe(201);
  fixtures.store_authorization = { id: started.body.id };
  aState = new URL(started.body.authorizeUrl).searchParams.get("state")!;
});

afterAll(async () => {
  await app?.close();
  await marketplace?.close();
});

/** Sends one operation as the given client; the method comes from the OpenAPI document. */
async function send(c: Client, method: string, url: string, body: object) {
  switch (method) {
    case "get":
      return c.get(url);
    case "post":
      return c.post(url, body);
    case "patch":
      return c.patch(url, body);
    case "put":
      return c.put(url, body);
    case "delete":
      return c.delete(url);
    default:
      throw new Error(`unsupported method ${method}`);
  }
}

function operations() {
  const ops: { method: string; path: string; id: string; isolation: Isolation | undefined }[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(
      item as Record<string, { operationId: string; "x-isolation"?: Isolation }>,
    )) {
      ops.push({ method, path, id: op.operationId, isolation: op["x-isolation"] });
    }
  }
  return ops;
}

describe("tenant isolation generated from openapi.json", () => {
  it("every operation declares x-isolation", () => {
    const missing = operations()
      .filter((o) => !o.isolation)
      .map((o) => `${o.method.toUpperCase()} ${o.path}`);
    expect(missing).toEqual([]);
  });

  it("every fixture kind has a factory and every mutating fixture operation has a body", () => {
    const missingFixture = new Set<string>();
    const missingBody: string[] = [];
    for (const o of operations()) {
      if (typeof o.isolation !== "object") continue;
      if (!fixtures[o.isolation.fixture]) missingFixture.add(o.isolation.fixture);
      if (o.method !== "get" && !BODIES[o.id]) missingBody.push(o.id);
    }
    expect([...missingFixture]).toEqual([]);
    expect(missingBody).toEqual([]);
  });

  it("tenant B cannot reach tenant A's resources through any operation", async () => {
    const [bViewer] = ((await b.c.get("/v1/roles")).body.items as { id: string; name: string }[]).filter(
      (r) => r.name === "Viewer",
    );
    const aIds = Object.fromEntries(Object.entries(fixtures).map(([k, f]) => [k, f.id]));
    const results: { op: string; status: number; ok: boolean }[] = [];

    for (const o of operations()) {
      if (typeof o.isolation !== "object") continue;
      const target = fixtures[o.isolation.fixture]!;
      const hasId = o.path.includes("{id}");
      let url = o.path.replace("{id}", target.id);
      for (const [param, kind] of Object.entries(PATH_PARAMS)) url = url.replace(param, fixtures[kind]!.id);
      const body = BODIES[o.id]?.({ a: aIds, bViewerRoleId: bViewer!.id, aState }) ?? {};
      const res = await send(b.c, o.method, url, body);

      let ok: boolean;
      if (hasId) ok = res.status === 404;
      else if (o.method === "get")
        ok = res.status === 200 && !(res.body.items ?? []).some((i: { id: string }) => i.id === target.id);
      else ok = [404, 412, 422].includes(res.status);
      results.push({ op: `${o.method.toUpperCase()} ${o.path}`, status: res.status, ok });
    }

    expect(results.length).toBeGreaterThanOrEqual(10);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it("aggregates count only the caller's own tenant", async () => {
    const mine = (await a.c.get("/v1/dashboard")).body;
    expect(mine.orders.statuses.problem).toBe(1);
    expect(mine.tasks.map((t: { kind: string }) => t.kind)).toContain("orders_problem");
    const theirs = await b.c.get("/v1/dashboard");
    expect(theirs.status).toBe(200);
    expect(Object.values(theirs.body.orders.statuses).every((n) => n === 0)).toBe(true);
    expect(theirs.body.sales).toMatchObject({ orders: 0, revenue: 0 });
    expect(theirs.body.urgentOrders).toEqual([]);
    expect(theirs.body.stores).toEqual([]);
    expect(theirs.body.tasks).toEqual([]);
    expect((await a.c.get("/v1/reports/sales")).body.summary).toMatchObject({ orders: 1, revenue: 50000 });
    const theirSales = await b.c.get("/v1/reports/sales");
    expect(theirSales.status).toBe(200);
    expect(theirSales.body.summary).toMatchObject({ orders: 0, revenue: 0, paidOrders: 0 });
    expect(theirSales.body.byStore).toEqual([]);
  });

  it("tenant A's resources are still intact afterwards", async () => {
    const res = await a.c.get(`/v1/users/${a.me.user.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Rina");
    const invitations = (await a.c.get("/v1/invitations")).body.items as { id: string }[];
    expect(invitations.map((i) => i.id)).toContain(fixtures.invitation!.id);
    const store = await a.c.get(`/v1/stores/${fixtures.store!.id}`);
    expect(store.body).toMatchObject({ name: "Toko Utama", status: "active" });
    const cws = (await a.c.get(`/v1/stores/${fixtures.store!.id}/channel-warehouses`)).body.items as {
      mappingStatus: string;
    }[];
    expect(cws.map((w) => w.mappingStatus)).toEqual(["unmapped"]);
    expect((await a.c.get(`/v1/products/${fixtures.product!.id}`)).body).toMatchObject({ name: "Kaos Tenant A" });
    expect((await a.c.get(`/v1/listings/${fixtures.listing!.id}`)).body).toMatchObject({
      status: "active",
      mapping: null,
    });
    const stock = (await a.c.get("/v1/inventory?q=A-KAOS-1")).body.items[0];
    expect(stock.warehouses[0]).toMatchObject({ onHand: 7, minStock: null });
    expect((await a.c.get(`/v1/stock-allocation-rules/${fixtures.stock_rule!.id}`)).body).toMatchObject({
      mode: "all",
      buffer: 2,
      value: 0,
    });
    const order = (await a.c.get(`/v1/orders/${fixtures.order!.id}`)).body;
    expect(order).toMatchObject({ status: "problem", internalNote: null });
    expect(order.problems).toMatchObject([{ code: "high_value", resolvedAt: null }]);
    expect((await a.c.get(`/v1/documents/${fixtures.document!.id}`)).body).toMatchObject({
      status: "queued",
      orderCount: 1,
    });
    expect((await a.c.get(`/v1/orders/${fixtures.order!.id}/shipments`)).body.items).toEqual([]);
    expect((await a.c.get(`/v1/exports/${fixtures.data_export!.id}`)).body).toMatchObject({
      status: "queued",
      downloadCount: 0,
    });
    expect((await a.c.get(`/v1/migration/imports/${fixtures.migration_job!.id}`)).body).toMatchObject({
      status: "uploaded",
      mapping: { fields: { sku_varian: 0 } },
    });
    expect(((await a.c.get("/v1/migration/presets")).body.items as { id: string }[]).map((p) => p.id)).toContain(
      fixtures.migration_preset!.id,
    );
    expect((await a.c.get("/v1/migration/cutovers")).body.items).toEqual([
      expect.objectContaining({ id: fixtures.store_cutover!.id, status: "done" }),
    ]);
    // B's callback attempt with A's state did not consume it
    expect((await a.c.get(`/v1/store-authorizations/${fixtures.store_authorization!.id}`)).body.status).toBe("pending");
  });
});
