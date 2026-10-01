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
const PATH_PARAMS: Record<string, string> = { "{channelWarehouseId}": "channel_warehouse" };

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
    // B's callback attempt with A's state did not consume it
    expect((await a.c.get(`/v1/store-authorizations/${fixtures.store_authorization!.id}`)).body.status).toBe("pending");
  });
});
