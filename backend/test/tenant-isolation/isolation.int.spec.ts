import type { INestApplication } from "@nestjs/common";
import type { OpenAPIObject } from "@nestjs/swagger";
import { newId, PERMISSION_CODES } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { buildOpenApiDocument } from "../../src/openapi/document";
import { type Client, client, type MeBody, signup, startApi, uniqueEmail } from "../setup/app";
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

type Isolation = "public" | "self" | "global" | { fixture: string; actor?: "device" };

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
/** Tenant B's print agent, for the agent's own routes (device token). */
let bAgent: Client;
const fixtures: Record<string, Fixture> = {};

/** Path parameters besides {id}, filled with A's fixture of the given kind. */
const PATH_PARAMS: Record<string, string> = {
  "{channelWarehouseId}": "channel_warehouse",
  "{variantId}": "variant",
  "{warehouseId}": "warehouse",
  "{problemId}": "order_problem",
  "{itemId}": "handover_item",
  "{categoryId}": "channel_category",
};

/** Bodies for mutating operations, keyed by operationId. `ids` holds A's fixture ids and B's own ids. */
const BODIES: Record<string, (ids: { a: Record<string, string>; bViewerRoleId: string; aState: string }) => object> = {
  AffiliateProductsController_request: () => ({ pageSize: 20 }),
  ListingsController_changePrice: () => ({ price: 1, expectedPrice: 2 }),
  ListingsController_cancelPrice: () => ({ changeId: newId() }),
  UsersController_update: () => ({ name: "Penyusup" }),
  UsersController_setRoles: ({ bViewerRoleId }) => ({ roleIds: [bViewerRoleId] }),
  UsersController_setScopes: () => ({ storeIds: null }),
  UsersController_revokeSessions: () => ({}),
  UsersController_resetTwoFactor: () => ({}),
  InvitationsController_create: ({ a: ids }) => ({ email: uniqueEmail("x"), roleId: ids.role! }),
  RolesController_update: () => ({ name: "Penyusup" }),
  RolesController_remove: () => ({}),
  OrderRulesController_create: ({ a: ids }) => ({
    name: "Penyusup",
    conditions: { storeIds: [ids.store!] },
    actions: { tagIds: [ids.tag!] },
  }),
  OrderRulesController_reorder: ({ a: ids }) => ({ ids: [ids.order_rule!] }),
  OrderRulesController_update: () => ({ name: "Penyusup", active: false }),
  OrderRulesController_remove: () => ({}),
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
  BusinessDocumentsController_update: () => ({ title: "Penyusup" }),
  BusinessDocumentsController_remove: () => ({}),
  BillingController_voidInvoice: () => ({}),
  CourierCutoffsController_add: ({ a: ids }) => ({
    warehouseId: ids.warehouse!,
    courier: "J&T Express",
    cutoffTime: "15:00",
    days: [1],
  }),
  CourierCutoffsController_update: () => ({ active: false }),
  CourierCutoffsController_remove: () => ({}),
  CourierHolidaysController_remove: () => ({}),
  OperatingHoursController_updatePeriod: () => ({ name: "Penyusup" }),
  OperatingHoursController_removePeriod: () => ({}),
  StoresController_disconnect: () => ({}),
  StoresController_syncWarehouses: () => ({}),
  StoresController_mapChannelWarehouse: ({ a: ids }) => ({ warehouseId: ids.warehouse! }),
  ProductsController_update: () => ({ name: "Penyusup" }),
  ProductsController_remove: () => ({}),
  ProductsController_addVariant: () => ({ sku: "PENYUSUP-1", basePrice: 1, weightG: 1 }),
  ProductsController_updateVariant: () => ({ basePrice: 1 }),
  ProductsController_generateBarcodes: ({ a: ids }) => ({ variantIds: [ids.variant!] }),
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
  OrdersController_createManual: ({ a: ids }) => ({
    storeId: ids.store!,
    buyer: { name: "Penyusup" },
    items: [{ variantId: ids.variant!, qty: 1 }],
    paymentMethod: "cash",
  }),
  OrdersController_setTags: ({ a: ids }) => ({ orderIds: [ids.order!], add: [ids.tag!] }),
  OrdersController_updateManual: () => ({ buyerNote: "Penyusup" }),
  OrdersController_pay: () => ({}),
  OrdersController_ship: () => ({}),
  OrdersController_complete: () => ({}),
  OrdersController_changeWarehouse: ({ a: ids }) => ({ warehouseId: ids.warehouse! }),
  TagsController_update: () => ({ name: "Penyusup" }),
  TagsController_remove: () => ({}),
  WarehousesController_update: () => ({ name: "Penyusup" }),
  WarehousesController_makeDefault: () => ({}),
  WarehousesController_remove: () => ({}),
  ShipmentsController_arrange: ({ a: ids }) => ({ orderIds: [ids.order!], method: "pickup" }),
  ShipmentsController_labels: ({ a: ids }) => ({ orderIds: [ids.order!] }),
  DocumentsController_create: ({ a: ids }) => ({ kind: "labels", orderIds: [ids.order!] }),
  DocumentsController_pickList: ({ a: ids }) => ({ orderIds: [ids.order!] }),
  DocumentsController_barcodeLabels: ({ a: ids }) => ({ items: [{ variantId: ids.variant!, copies: 1 }] }),
  ShipmentsController_refreshTracking: () => ({}),
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
  PrintAgentsController_create: ({ a: ids }) => ({ name: "Penyusup", warehouseId: ids.warehouse! }),
  PrintAgentsController_update: () => ({ name: "Penyusup" }),
  PrintAgentsController_revoke: () => ({}),
  PrintAgentsController_testPrint: () => ({}),
  PrintJobsController_create: ({ a: ids }) => ({ documentId: ids.document!, deviceId: ids.print_agent! }),
  PrintJobsController_scanToPrint: ({ a: ids }) => ({ code: "A-0001", deviceId: ids.print_agent! }),
  PrintJobsController_retry: () => ({}),
  PrintJobsController_cancel: () => ({}),
  AgentController_result: () => ({ status: "printed" }),
  AgentController_retry: () => ({}),
  PackingController_complete: () => ({ scans: [{ code: "A-KAOS-1", qty: 1 }] }),
  HandoversController_open: ({ a: ids }) => ({ warehouseId: ids.warehouse!, courier: "Penyusup" }),
  HandoversController_scan: () => ({ code: "A-0001" }),
  HandoversController_removeItem: () => ({}),
  HandoversController_complete: () => ({}),
  HandoversController_cancel: () => ({}),
  HandoversController_manifest: () => ({}),
  StoreCategoriesController_refresh: () => ({}),
  ListingCopiesController_create: ({ a: ids }) => ({ sourceStoreId: ids.store!, targetStoreIds: [ids.store!] }),
  ListingCopiesController_cancel: () => ({}),
  ListingDraftsController_update: () => ({ title: "Penyusup" }),
  ListingDraftsController_remove: () => ({}),
  ListingDraftsController_setCategory: ({ a: ids }) => ({ draftIds: [ids.listing_draft!], categoryId: "601226" }),
  ListingDraftsController_setAttribute: ({ a: ids }) => ({
    draftIds: [ids.listing_draft!],
    attributeId: "102254",
    values: [{ valueId: "1000059" }],
  }),
  ListingDraftsController_publish: ({ a: ids }) => ({ draftIds: [ids.listing_draft!] }),
  ReturnsController_refresh: () => ({}),
  ReturnsController_addEvidence: () => ({ content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString("base64") }),
  ReturnsController_accept: () => ({}),
  ReturnsController_reject: () => ({ reason: "seller_reject_apply_product_has_been_packed" }),
  ReturnsController_receive: ({ a: ids }) => ({
    items: [{ returnItemId: ids.return_item!, sellable: 0, damaged: 0, missing: 1 }],
  }),
  StockCountsController_create: ({ a: ids }) => ({ warehouseId: ids.warehouse!, mode: "full" }),
  StockCountsController_record: ({ a: ids }) => ({ lines: [{ variantId: ids.variant!, qty: 99, mode: "set" }] }),
  StockCountsController_scan: () => ({ code: "A-KAOS-1" }),
  StockCountsController_submit: () => ({}),
  StockCountsController_reopen: () => ({}),
  StockCountsController_apply: () => ({ zeroUncounted: true }),
  StockCountsController_cancel: () => ({}),
  StockTransfersController_create: ({ a: ids }) => ({
    fromWarehouseId: ids.warehouse!,
    toWarehouseId: ids.second_warehouse!,
    lines: [{ variantId: ids.variant!, qty: 1 }],
  }),
  StockTransfersController_update: () => ({ note: "Penyusup" }),
  StockTransfersController_send: () => ({}),
  StockTransfersController_receive: () => ({}),
  StockTransfersController_cancel: () => ({}),
};

/** A print agent's client: its device token instead of a session. */
function deviceClient(token: string): Client {
  const base = client(app);
  const bearer = <T extends { set(k: string, v: string): T }>(r: T) => r.set("authorization", `Bearer ${token}`);
  return {
    ...base,
    get: (url: string) => bearer(base.get(url)),
    post: (url: string, body?: object) => bearer(base.post(url, body)),
    patch: (url: string, body?: object) => bearer(base.patch(url, body)),
    put: (url: string, body?: object) => bearer(base.put(url, body)),
    delete: (url: string) => bearer(base.delete(url)),
  };
}

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
  // a legal document of tenant A (a 1-page PDF header is enough for the type check)
  const legal = await a.c.post("/v1/business-documents", {
    kind: "nib",
    fileName: "nib.pdf",
    content: Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64"),
  });
  expect(legal.status, JSON.stringify(legal.body)).toBe(201);
  fixtures.business_document = { id: legal.body.id };

  const warehouses = (await a.c.get("/v1/warehouses")).body.items as { id: string }[];
  fixtures.warehouse = { id: warehouses[0]!.id };
  // when tenant A's parcels must be ready (backend doc 8.31)
  const cutoff = await a.c.post("/v1/courier-cutoffs", {
    warehouseId: fixtures.warehouse.id,
    courier: "J&T Express",
    cutoffTime: "15:00",
    days: [1, 2, 3, 4, 5],
  });
  expect(cutoff.status, JSON.stringify(cutoff.body)).toBe(201);
  fixtures.courier_cutoff = { id: cutoff.body.id };
  const holiday = await a.c.post("/v1/courier-holidays", { date: "2026-12-25", courier: null, note: "Natal" });
  expect(holiday.status, JSON.stringify(holiday.body)).toBe(201);
  fixtures.courier_holiday = { id: holiday.body.id };
  const period = await a.c.post("/v1/operating-hours/periods", {
    name: "Ramadan",
    from: "2027-02-08",
    to: "2027-03-08",
    schedule: [null, ...Array.from({ length: 6 }, () => ({ open: "08:00", close: "13:00" }))],
  });
  expect(period.status, JSON.stringify(period.body)).toBe(201);
  fixtures.operating_hours = { id: period.body.id };
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
  // a stock count being counted and a transfer draft to a second warehouse (8.27)
  const counting = await a.c.post("/v1/stock-counts", { warehouseId: fixtures.warehouse.id, mode: "full" });
  expect(counting.status).toBe(201);
  fixtures.stock_count = { id: counting.body.id };
  expect(
    (
      await a.c.put(`/v1/stock-counts/${counting.body.id}/lines`, {
        lines: [{ variantId: fixtures.variant.id, qty: 6, mode: "set" }],
      })
    ).status,
  ).toBe(200);
  const second = await a.c.post("/v1/warehouses", { code: "A-DUA", name: "Gudang Dua A" });
  expect(second.status).toBe(201);
  fixtures.second_warehouse = { id: second.body.id };
  const draft = await a.c.post("/v1/stock-transfers", {
    fromWarehouseId: fixtures.warehouse.id,
    toWarehouseId: second.body.id,
    lines: [{ variantId: fixtures.variant.id, qty: 2 }],
  });
  expect(draft.status).toBe(201);
  fixtures.stock_transfer = { id: draft.body.id };
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
    // tenant A's trial and an invoice waiting to be paid (backend doc 8.32)
    const growth = await tx.execute<{ id: string }>(sql`SELECT id FROM plan WHERE code = 'growth'`);
    const subscriptionId = newId();
    await tx.execute(sql`INSERT INTO subscription (id, tenant_id, plan_id, status, current_period_start, current_period_end)
                         VALUES (${subscriptionId}, ${tenantId}, ${growth.rows[0]!.id}, 'trialing', now(), now() + interval '14 days')`);
    const invoiceId = newId();
    await tx.execute(sql`INSERT INTO invoice (id, tenant_id, subscription_id, plan_id, number, kind, amount, period_start, period_end,
                                              due_at, invoice_expires_at)
                         VALUES (${invoiceId}, ${tenantId}, ${subscriptionId}, ${growth.rows[0]!.id}, 'INV-2610-0001', 'upgrade', 899000,
                                 now(), now() + interval '1 month', now() + interval '1 day', now() + interval '1 day')`);
    fixtures.invoice = { id: invoiceId };
  });
  // a print agent with a job waiting for its document, and a courier manifest with one parcel (8.24)
  const agent = await a.c.post("/v1/print-agents", { name: "Agen A" });
  expect(agent.status).toBe(201);
  fixtures.print_agent = { id: agent.body.agent.id };
  const job = await a.c.post(`/v1/print-agents/${agent.body.agent.id}/test-print`, {});
  expect(job.status).toBe(201);
  fixtures.print_job = { id: job.body.id };
  const opened = await a.c.post("/v1/handovers", { warehouseId: fixtures.warehouse.id, courier: "SPX Standard" });
  expect(opened.status).toBe(201);
  fixtures.handover = { id: opened.body.id };
  await withTenantTx(h.worker, userCtx(tenantId), async (tx) => {
    const itemId = newId();
    await tx.execute(sql`INSERT INTO handover_item (id, tenant_id, handover_id, order_id, tracking_number, order_number)
                         VALUES (${itemId}, ${tenantId}, ${opened.body.id}, ${fixtures.order!.id}, 'A-RESI-1', 'A-0001')`);
    fixtures.handover_item = { id: itemId };
  });
  // a copy of A's store into itself is impossible; the fixture copies between two stores of A (8.25)
  await withTenantTx(h.worker, userCtx(tenantId), async (tx) => {
    const otherStoreId = await createStore(tx, tenantId, {
      warehouseId: fixtures.warehouse!.id,
      channel: "tiktokshop",
    });
    await tx.execute(sql`INSERT INTO channel_category (id, tenant_id, store_id, external_id, name, path, is_leaf, seen_at)
                         VALUES (${newId()}, ${tenantId}, ${fixtures.store!.id}, '601226', 'Kaos', 'Pakaian Pria > Kaos', true, now())`);
    fixtures.channel_category = { id: "601226" };
    const copyId = newId();
    await tx.execute(sql`INSERT INTO listing_copy (id, tenant_id, source_store_id, target_store_id, scope, options)
                         VALUES (${copyId}, ${tenantId}, ${fixtures.store!.id}, ${otherStoreId}, 'store',
                                 '{"priceChangePercent":0,"skipListed":true}'::jsonb)`);
    fixtures.listing_copy = { id: copyId };
    const draftId = newId();
    await tx.execute(sql`INSERT INTO listing_draft (id, tenant_id, copy_id, source_store_id, target_store_id,
                                                    external_source_item_id, title, source)
                         VALUES (${draftId}, ${tenantId}, ${copyId}, ${fixtures.store!.id}, ${otherStoreId}, '9001',
                                 'Kaos Tenant A',
                                 '{"channel":"shopee","category":{"externalId":"100017","name":null,"path":null},"brand":null,"attributes":[],"extras":{},"notes":[]}'::jsonb)`);
    fixtures.listing_draft = { id: draftId };
  });
  // a buyer's return of A's order waiting for a decision, as the worker would have read it (8.26)
  await withTenantTx(h.worker, userCtx(tenantId), async (tx) => {
    const returnId = newId();
    await tx.execute(sql`INSERT INTO return_request (id, tenant_id, store_id, order_id, warehouse_id, kind, external_return_id,
                                                     status, external_status, goods_return, decisions, decisions_for)
                         VALUES (${returnId}, ${tenantId}, ${fixtures.store!.id}, ${fixtures.order!.id}, ${fixtures.warehouse!.id},
                                 'return_refund', 'RET-A-0001', 'requested', 'REQUESTED', true,
                                 '[{"code":"confirm","action":"accept","label":"Setujui","reasons":[],"needsEmail":false}]'::jsonb,
                                 'REQUESTED')`);
    fixtures.return_request = { id: returnId };
    const itemId = newId();
    await tx.execute(sql`INSERT INTO return_item (id, tenant_id, return_request_id, sku, title, qty)
                         VALUES (${itemId}, ${tenantId}, ${returnId}, 'A-KAOS-1', 'Kaos Tenant A', 1)`);
    fixtures.return_item = { id: itemId };
  });
  const theirs = await b.c.post("/v1/print-agents", { name: "Agen B" });
  expect(theirs.status).toBe(201);
  bAgent = deviceClient(theirs.body.token);

  const tag = await a.c.post("/v1/tags", { name: "Prioritas A", color: "#1e6b8c" });
  expect(tag.status).toBe(201);
  fixtures.tag = { id: tag.body.id };
  expect((await a.c.post("/v1/orders/tags", { orderIds: [fixtures.order!.id], add: [tag.body.id] })).status).toBe(200);
  // a rule of tenant A that tags its Shopee orders (backend doc 8.37)
  const orderRule = await a.c.post("/v1/order-rules", {
    name: "Tag Toko Utama",
    conditions: { storeIds: [fixtures.store!.id] },
    actions: { tagIds: [tag.body.id] },
  });
  expect(orderRule.status, JSON.stringify(orderRule.body)).toBe(201);
  fixtures.order_rule = { id: orderRule.body.id };
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
  it("describes nullable values as nullable, never as arrays (patches/nestjs-zod)", () => {
    const schemas = (doc.components?.schemas ?? {}) as Record<string, { properties: Record<string, unknown> }>;
    const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
    // zod writes `type: ["string", "null"]`, which @nestjs/swagger used to read as an array of strings
    expect(schemas.OrderPageDto_Output?.properties.next_cursor).toEqual(nullableString);
    expect(schemas.StockCountDto_Output?.properties.note).toEqual(nullableString);
    expect(schemas.OrderPageDto_Output?.properties.items).toMatchObject({ type: "array" });
  });

  it("documents every success answer under its status, never as `default` (generated clients read that as the error)", () => {
    const withDefault = operations()
      .filter(
        (o) => "default" in ((doc.paths[o.path] as Record<string, { responses: object }>)[o.method]?.responses ?? {}),
      )
      .map((o) => `${o.method.toUpperCase()} ${o.path}`);
    expect(withDefault).toEqual([]);
    const statuses = (path: string, method: string) =>
      Object.keys((doc.paths[path] as Record<string, { responses: object }>)[method]!.responses);
    expect(statuses("/v1/orders", "get")).toEqual(["200"]);
    expect(statuses("/v1/stock-counts", "post")).toEqual(["201"]);
    expect(statuses("/v1/stock-counts/{id}/apply", "post")).toEqual(["202"]);
    expect(statuses("/v1/auth/logout", "post")).toEqual(["204"]);
  });

  it("names the permission codes of GET /v1/me, so clients can type their checks", () => {
    const me = doc.components?.schemas?.MeDto_Output as {
      properties: { permissions: { items: { enum: string[] } } };
    };
    expect(me.properties.permissions.items.enum).toEqual(PERMISSION_CODES);
  });

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
      const res = await send(o.isolation.actor === "device" ? bAgent : b.c, o.method, url, body);

      let ok: boolean;
      if (hasId) ok = res.status === 404;
      else if (o.method === "get")
        ok = res.status === 200 && !(res.body.items ?? []).some((i: { id: string }) => i.id === target.id);
      else ok = [404, 412, 422].includes(res.status);
      results.push({ op: `${o.method.toUpperCase()} ${o.path}`, status: res.status, ok });
    }

    expect(results.length).toBeGreaterThanOrEqual(10);
    // the print agent's own routes ran with tenant B's device token
    expect(results.filter((r) => r.op.includes("/v1/agent/")).length).toBeGreaterThanOrEqual(3);
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
    // only B's own: its missing NIB (backend doc 8.29), never A's orders
    expect(theirs.body.tasks.map((t: { kind: string }) => t.kind)).toEqual(["legal_nib"]);
    expect((await a.c.get("/v1/reports/sales")).body.summary).toMatchObject({ orders: 1, revenue: 50000 });
    expect((await b.c.get("/v1/tags")).body.items).toEqual([]);
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
    expect(order).toMatchObject({ status: "problem", internalNote: null, warehouseId: fixtures.warehouse!.id });
    expect(order.tags).toEqual([{ id: fixtures.tag!.id, name: "Prioritas A", color: "#1E6B8C" }]);
    expect((await a.c.get("/v1/tags")).body.items).toEqual([
      { id: fixtures.tag!.id, name: "Prioritas A", color: "#1E6B8C", orders: 1 },
    ]);
    expect((await a.c.get("/v1/order-rules")).body.items).toMatchObject([
      { id: fixtures.order_rule!.id, name: "Tag Toko Utama", active: true, priority: 1 },
    ]);
    expect((await a.c.get(`/v1/warehouses/${fixtures.warehouse!.id}`)).body).toMatchObject({
      name: "Gudang Utama",
      isDefault: true,
    });
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
    expect((await a.c.get(`/v1/print-agents/${fixtures.print_agent!.id}`)).body).toMatchObject({ name: "Agen A" });
    expect((await a.c.get(`/v1/print-jobs/${fixtures.print_job!.id}`)).body).toMatchObject({
      status: "queued",
      attempts: 0,
    });
    expect((await a.c.get(`/v1/handovers/${fixtures.handover!.id}`)).body).toMatchObject({
      status: "open",
      courier: "SPX Standard",
      parcels: 1,
    });
    expect((await a.c.get(`/v1/listing-copies/${fixtures.listing_copy!.id}`)).body).toMatchObject({
      status: "preparing",
    });
    expect((await a.c.get(`/v1/listing-drafts/${fixtures.listing_draft!.id}`)).body).toMatchObject({
      status: "draft",
      title: "Kaos Tenant A",
    });
    expect((await a.c.get(`/v1/returns/${fixtures.return_request!.id}`)).body).toMatchObject({
      status: "requested",
      response: null,
      receivedAt: null,
      sellerEvidence: [],
    });
    expect((await a.c.get(`/v1/stock-counts/${fixtures.stock_count!.id}`)).body).toMatchObject({
      status: "counting",
      applyRequestedAt: null,
      stats: { counted: 1 },
    });
    expect((await a.c.get(`/v1/stock-counts/${fixtures.stock_count!.id}/lines`)).body.items).toEqual([
      expect.objectContaining({ variantId: fixtures.variant!.id, countedQty: 6, expectedQty: null }),
    ]);
    expect((await a.c.get(`/v1/stock-transfers/${fixtures.stock_transfer!.id}`)).body).toMatchObject({
      status: "draft",
      note: null,
      lines: [{ qty: 2, receivedQty: null }],
    });
    // B's callback attempt with A's state did not consume it
    expect((await a.c.get(`/v1/store-authorizations/${fixtures.store_authorization!.id}`)).body.status).toBe("pending");
  });
});
