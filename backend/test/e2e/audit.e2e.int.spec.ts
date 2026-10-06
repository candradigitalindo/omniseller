import type { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemContext } from "../../src/common/context/request-context";
import { AuditLogService } from "../../src/modules/audit/audit-log.service";
import { client, type MeBody, PASSWORD, signup, startApi, startWorker, tokenFrom, uniqueEmail } from "../setup/app";
import { testHandles } from "../setup/handles";

const h = testHandles();
let app: INestApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  app = await startApi(h.infra);
  worker = await startWorker(h.infra, h.system);
});

afterAll(async () => {
  await app?.close();
  await worker?.close();
});

type Client = ReturnType<typeof client>;
interface Entry {
  id: string;
  entityType: string;
  actorId: string | null;
  requestId: string | null;
  actor: { type: string; id: string | null; name: string | null };
  change: string;
  label: string | null;
  changes: { field: string; before: unknown; after: unknown; hidden?: true }[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

async function roleId(c: Client, name: string): Promise<string> {
  const res = await c.get("/v1/roles");
  return (res.body.items as { id: string; name: string }[]).find((r) => r.name === name)!.id;
}

async function addMember(owner: Client, tenantId: string, role: string, name: string) {
  const email = uniqueEmail("staf");
  const invite = await owner.post("/v1/invitations", { email, roleId: await roleId(owner, role) });
  expect(invite.status).toBe(201);
  await worker.runOutbox(tenantId);
  const token = tokenFrom(worker.email.lastTo(email)!.text);
  const member = client(app);
  const accepted = await member.post("/v1/auth/invitations/accept", { token, name, password: PASSWORD });
  expect(accepted.status).toBe(201);
  return { member, me: accepted.body as MeBody };
}

async function shirt(c: Client, sku = `KAOS-${Date.now().toString(36).toUpperCase()}`) {
  const res = await c.post("/v1/products", {
    sku,
    name: "Kaos Polos",
    variants: [{ sku: `${sku}-HTM`, basePrice: 65_000, costPrice: 35_000, weightG: 200 }],
  });
  expect(res.status).toBe(201);
  return { productId: res.body.id as string, variantId: res.body.variants[0].id as string, sku: `${sku}-HTM` };
}

async function entries(c: Client, query: string): Promise<{ items: Entry[]; next_cursor: string | null }> {
  const res = await c.get(`/v1/audit-logs?${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** Writes a business's warehouse without changing anything a seller sees: audited rows the log skips. */
async function touchWarehouse(tenantId: string, times: number) {
  await h.worker.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(
      sql.raw(`DO $$ BEGIN FOR i IN 1..${times} LOOP UPDATE warehouse SET name = name; END LOOP; END $$`),
    );
  });
}

describe("audit log as the seller reads it (PRD FR-USR-04, backend doc 8.28)", () => {
  it("says who changed a price, on which SKU, before and after", async () => {
    const { c, me } = await signup(app);
    const v = await shirt(c);
    const patched = await c.patch(`/v1/products/${v.productId}/variants/${v.variantId}`, { basePrice: 69_000 });
    expect(patched.status).toBe(200);

    const [latest] = (await entries(c, "entity_type=variant&limit=5")).items;
    expect(latest).toMatchObject({
      entityType: "variant",
      actor: { type: "user", id: me.user.id, name: "Rina" },
      change: "updated",
      label: v.sku,
      changes: [{ field: "basePrice", before: 65_000, after: 69_000 }],
    });
  });

  it("keeps cost prices from readers without finance:read", async () => {
    const { c, me } = await signup(app);
    const v = await shirt(c);
    await c.patch(`/v1/products/${v.productId}/variants/${v.variantId}`, { costPrice: 36_000 });
    const log = app.get(AuditLogService, { strict: false });
    const reader = { ...systemContext(me.tenant.id), permissions: new Set(["audit:read" as const]) };
    const [entry] = (await log.list(reader, { entityTypes: ["variant"] }, undefined, 1)).items;
    expect(entry!.changes).toEqual([{ field: "costPrice", before: null, after: null, hidden: true }]);
    expect(entry!.before).not.toHaveProperty("cost_price");
    expect(entry!.after).not.toHaveProperty("cost_price");
    // the Owner holds finance:read
    const [own] = (await entries(c, "entity_type=variant&limit=1")).items;
    expect(own!.changes).toEqual([{ field: "costPrice", before: 35_000, after: 36_000 }]);
  });

  it("lets an Admin, who cannot list users, see the team by name", async () => {
    const { c: owner, me } = await signup(app);
    const { member: admin, me: am } = await addMember(owner, me.tenant.id, "Admin", "Budi Santoso");
    const { me: viewer } = await addMember(owner, me.tenant.id, "Viewer", "Sari Dewi");
    await owner.put(`/v1/users/${viewer.user.id}/roles`, { roleIds: [await roleId(owner, "CS")] });
    expect((await admin.get("/v1/users")).status).toBe(403);

    const log = await entries(admin, "entity_type=user_role&limit=10");
    const byOwner = log.items.filter((e) => e.actorId === me.user.id);
    // one request: which row the database wrote first is not part of the contract
    expect(byOwner).toHaveLength(2);
    expect(byOwner.map((e) => [e.change, e.label, e.changes])).toEqual(
      expect.arrayContaining([
        [
          "created",
          "Sari Dewi",
          [
            { field: "user", before: null, after: "Sari Dewi" },
            { field: "role", before: null, after: "CS" },
          ],
        ],
        [
          "deleted",
          "Sari Dewi",
          [
            { field: "user", before: "Sari Dewi", after: null },
            { field: "role", before: "Viewer", after: null },
          ],
        ],
      ]),
    );
    expect(byOwner.every((e) => e.actor.name === "Rina")).toBe(true);
    // a role change is one request: the deletion and the new role share it
    expect(new Set(byOwner.map((e) => e.requestId)).size).toBe(1);

    const people = await admin.get("/v1/audit-logs/people");
    expect(people.status).toBe(200);
    expect((people.body.items as { name: string }[]).map((p) => p.name)).toEqual(["Budi Santoso", "Rina", "Sari Dewi"]);
    expect(am.permissions).toContain("audit:read");
  });

  it("names stock changes and cancellations by SKU, warehouse, and order number", async () => {
    const { c } = await signup(app);
    const v = await shirt(c);
    const warehouse = (await c.get("/v1/warehouses")).body.items[0] as { id: string; name: string };
    const adjusted = await c.post("/v1/inventory/adjustments", {
      reason: "correction",
      note: "stok awal",
      lines: [{ variantId: v.variantId, warehouseId: warehouse.id, mode: "set", quantity: 12 }],
    });
    expect(adjusted.status).toBe(200);
    const store = await c.post("/v1/stores/manual", { name: "WhatsApp" });
    const order = await c.post("/v1/orders/manual", {
      storeId: store.body.id,
      buyer: { name: "Dewi Anggraini", phone: "081234567801" },
      shippingAddress: { line1: "Jl. Melati No. 5", city: "Kota Bandung", province: "Jawa Barat", postalCode: "40132" },
      items: [{ variantId: v.variantId, qty: 1 }],
      shippingFee: 0,
      discount: 0,
      paymentMethod: "transfer",
      paid: true,
    });
    expect(order.status).toBe(201);
    expect((await c.post(`/v1/orders/${order.body.id}/cancel`, { reason: "out_of_stock" })).status).toBeLessThan(300);

    const log = await entries(c, "entity_type=stock_movement,order_event&limit=10");
    expect(log.items.map((e) => e.entityType)).toEqual(["order_event", "stock_movement"]);
    expect(log.items[0]).toMatchObject({
      label: order.body.externalOrderId,
      changes: [
        { field: "order", after: order.body.externalOrderId },
        { field: "reason", after: "Stok habis" },
      ],
    });
    expect(log.items[1]).toMatchObject({ label: v.sku, change: "created" });
    expect(Object.fromEntries(log.items[1]!.changes.map((ch) => [ch.field, ch.after]))).toMatchObject({
      variant: v.sku,
      warehouse: warehouse.name,
      type: "adjustment",
      onHandDelta: 12,
      onHandAfter: 12,
      reason: "correction",
      note: "stok awal",
    });
    // buyer details never reach the log
    expect(JSON.stringify(log.items)).not.toContain("Dewi Anggraini");
  });

  it("skips rows a seller would not recognise while filling a page, and pages on", async () => {
    const { c, me } = await signup(app);
    const v = await shirt(c);
    const price = (n: number) => c.patch(`/v1/products/${v.productId}/variants/${v.variantId}`, { basePrice: n });
    await price(70_000);
    await price(71_000);
    await touchWarehouse(me.tenant.id, 250);
    await price(72_000);
    await price(73_000);

    const first = await entries(c, "entity_type=variant,warehouse&limit=3");
    expect(first.items.map((e) => e.changes[0]?.after)).toEqual([73_000, 72_000, 71_000]);
    expect(first.next_cursor).not.toBeNull();
    const second = await entries(c, `entity_type=variant,warehouse&limit=3&cursor=${first.next_cursor}`);
    expect(second.items.map((e) => [e.entityType, e.change, e.changes[0]?.after])).toEqual([
      ["variant", "updated", 70_000],
      ["variant", "created", v.sku],
      ["warehouse", "created", expect.any(String)],
    ]);
  });

  it("ends a page early after many unrecognised rows, and the cursor goes on from there", async () => {
    const { c, me } = await signup(app);
    const v = await shirt(c);
    await c.patch(`/v1/products/${v.productId}/variants/${v.variantId}`, { basePrice: 80_000 });
    await touchWarehouse(me.tenant.id, 2_100);

    const first = await entries(c, "entity_type=variant,warehouse&limit=5");
    expect(first.items).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    const second = await entries(c, `entity_type=variant,warehouse&limit=5&cursor=${first.next_cursor}`);
    expect(second.items[0]?.changes).toEqual([{ field: "basePrice", before: 65_000, after: 80_000 }]);
  });

  it("narrows to one person and to a time", async () => {
    const { c: owner, me } = await signup(app);
    const { member: admin, me: am } = await addMember(owner, me.tenant.id, "Admin", "Budi Santoso");
    const v = await shirt(owner);
    await owner.patch(`/v1/products/${v.productId}/variants/${v.variantId}`, { basePrice: 66_000 });
    const between = new Date();
    await admin.patch(`/v1/products/${v.productId}/variants/${v.variantId}`, { basePrice: 67_000 });

    const byAdmin = await entries(owner, `actor_id=${am.user.id}`);
    expect(byAdmin.items.map((e) => e.changes[0]?.after)).toEqual([67_000]);
    expect(byAdmin.items.every((e) => e.actor.name === "Budi Santoso")).toBe(true);

    const since = await entries(owner, `entity_type=variant&from=${encodeURIComponent(between.toISOString())}`);
    expect(since.items.map((e) => e.changes[0]?.after)).toEqual([67_000]);
    const until = await entries(owner, `entity_type=variant&to=${encodeURIComponent(between.toISOString())}`);
    expect(until.items.map((e) => e.changes[0]?.after)).toEqual([66_000, v.sku]);
  });

  it("refuses readers without audit:read and malformed filters", async () => {
    const { c: owner, me } = await signup(app);
    const { member: viewer } = await addMember(owner, me.tenant.id, "Viewer", "Sari Dewi");
    expect((await viewer.get("/v1/audit-logs")).status).toBe(403);
    expect((await viewer.get("/v1/audit-logs/people")).status).toBe(403);
    expect((await owner.get("/v1/audit-logs?entity_type=variant;drop")).status).toBe(422);
    expect((await owner.get("/v1/audit-logs?from=kemarin")).status).toBe(422);
  });
});
