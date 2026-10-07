import type { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDate } from "../../src/common/time-zone";
import { withTenantTx } from "../../src/db/tenant-tx";
import { addDays } from "../../src/modules/campaign/cutoff-plan";
import { OrderDeadlinesService } from "../../src/modules/orders/order-deadlines.service";
import { type Client, client, PASSWORD, signup, startApi, startWorker, tokenFrom, uniqueEmail } from "../setup/app";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";

/** Courier cut-offs, courier holidays, operating hours, and the internal deadlines of orders (backend doc 8.31). */

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

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const open = (o: string, c: string) => ({ open: o, close: c });
/** A local time in Jakarta as an ISO instant, on a date counted from today there. */
const wib = (daysFromToday: number, time: string) =>
  new Date(`${addDays(localDate("Asia/Jakarta", new Date()), daysFromToday)}T${time}:00+07:00`).toISOString();

async function shopWithStock(c: Client) {
  const warehouseId = ((await c.get("/v1/warehouses")).body.items as { id: string }[])[0]!.id;
  const sku = `KAOS-${Date.now().toString(36).toUpperCase()}`;
  const product = await c.post("/v1/products", {
    sku,
    name: "Kaos Polos",
    variants: [{ sku: `${sku}-HTM`, basePrice: 65_000, costPrice: 35_000, weightG: 200 }],
  });
  expect(product.status).toBe(201);
  const variantId = product.body.variants[0].id as string;
  const stock = await c.post("/v1/inventory/adjustments", {
    reason: "correction",
    lines: [{ variantId, warehouseId, mode: "set", quantity: 50 }],
  });
  expect(stock.status).toBe(200);
  const store = await c.post("/v1/stores/manual", { name: "WhatsApp" });
  expect(store.status).toBe(201);
  return { warehouseId, variantId, storeId: store.body.id as string };
}

async function manualOrder(c: Client, shop: { variantId: string; storeId: string }, courier: string) {
  const res = await c.post("/v1/orders/manual", {
    storeId: shop.storeId,
    buyer: { name: "Dewi Anggraini", phone: "081234567801" },
    shippingAddress: { line1: "Jl. Melati No. 5", city: "Kota Bandung", province: "Jawa Barat", postalCode: "40132" },
    items: [{ variantId: shop.variantId, qty: 1 }],
    shippingFee: 0,
    discount: 0,
    paymentMethod: "transfer",
    paid: true,
    shippingProvider: courier,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; internalShipByAt: string | null };
}

/** When the order was placed and paid (it became the seller's to process when paid), fixed for the test. */
async function readyAt(orderId: string, paidAt: string, orderedAt = paidAt): Promise<void> {
  await h.system.db.execute(
    sql`UPDATE "order" SET ordered_at = ${orderedAt}, paid_at = ${paidAt} WHERE id = ${orderId}`,
  );
}

async function order(c: Client, id: string) {
  const res = await c.get(`/v1/orders/${id}`);
  expect(res.status).toBe(200);
  return res.body as { internalShipByAt: string | null; internalSla: { state: string } | null };
}

describe("Kurir & Jam Operasional (L43)", () => {
  it("keeps a cut-off per warehouse and courier, checked and versioned", async () => {
    const { c } = await signup(app);
    const warehouseId = ((await c.get("/v1/warehouses")).body.items as { id: string }[])[0]!.id;
    const add = await c.post("/v1/courier-cutoffs", {
      warehouseId,
      courier: "  J&T   Express ",
      cutoffTime: "15:00",
      days: [6, 1, 2, 3, 4, 5, 1],
    });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body).toMatchObject({
      courier: "J&T Express",
      cutoffTime: "15:00",
      days: [1, 2, 3, 4, 5, 6],
      active: true,
    });

    const again = await c.post("/v1/courier-cutoffs", {
      warehouseId,
      courier: "j&t express",
      cutoffTime: "16:00",
      days: [1],
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("courier_cutoff.duplicate");
    const badTime = await c.post("/v1/courier-cutoffs", {
      warehouseId,
      courier: "JNE",
      cutoffTime: "25:00",
      days: [1],
    });
    expect(badTime.status).toBe(422);
    expect(badTime.body.errors[0].path).toBe("cutoffTime");
    expect(
      (await c.post("/v1/courier-cutoffs", { warehouseId, courier: "JNE", cutoffTime: "14:00", days: [] })).status,
    ).toBe(422);

    const id = add.body.id as string;
    const stale = await c.patch(`/v1/courier-cutoffs/${id}`, { cutoffTime: "16:00" }).set("If-Match", '"99"');
    expect(stale.body.code).toBe("row.stale");
    const moved = await c
      .patch(`/v1/courier-cutoffs/${id}`, { cutoffTime: "16:30", active: false })
      .set("If-Match", `"${add.body.rowVersion}"`);
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ cutoffTime: "16:30", active: false });
    expect((await c.get("/v1/courier-cutoffs")).body.items).toHaveLength(1);
    expect((await c.delete(`/v1/courier-cutoffs/${id}`)).status).toBe(204);
    expect((await c.delete(`/v1/courier-cutoffs/${id}`)).status).toBe(404);

    const log = await c.get("/v1/audit-logs?entity_type=courier_cutoff");
    expect(log.body.items.map((e: { change: string }) => e.change)).toEqual(["deleted", "updated", "created"]);
    expect(log.body.items[1]).toMatchObject({ label: "J&T Express" });
  });

  it("keeps courier holidays and operating hours, with special periods that may not overlap", async () => {
    const { c } = await signup(app);
    const holiday = await c.post("/v1/courier-holidays", { date: "2026-12-25", courier: null, note: "Natal" });
    expect(holiday.status).toBe(201);
    expect(holiday.body).toMatchObject({ date: "2026-12-25", courier: null, note: "Natal" });
    expect((await c.post("/v1/courier-holidays", { date: "2026-12-25" })).body.code).toBe("courier_holiday.duplicate");
    expect((await c.post("/v1/courier-holidays", { date: "2026-12-25", courier: "JNE" })).status).toBe(201);
    const list = await c.get("/v1/courier-holidays?from=2026-12-01");
    expect(list.body.items.map((x: { courier: string | null }) => x.courier)).toEqual([null, "JNE"]);
    expect((await c.delete(`/v1/courier-holidays/${holiday.body.id}`)).status).toBe(204);

    expect((await c.get("/v1/operating-hours")).body).toEqual({ week: null, periods: [] });
    const week = [null, ...Array.from({ length: 5 }, () => open("08:00", "17:00")), open("08:00", "14:00")];
    const set = await c.put("/v1/operating-hours/week", { schedule: week });
    expect(set.status).toBe(200);
    expect(set.body.schedule).toEqual(week);
    const backwards = await c.put("/v1/operating-hours/week", {
      schedule: [...week.slice(0, 6), open("14:00", "08:00")],
    });
    expect(backwards.status).toBe(422);
    expect(backwards.body.errors).toEqual([{ path: "schedule", message: "Jam tutup harus setelah jam buka." }]);

    const ramadan = week.map((d) => (d ? open("08:00", "13:00") : null));
    const period = await c.post("/v1/operating-hours/periods", {
      name: "Ramadan",
      from: "2027-02-08",
      to: "2027-03-08",
      schedule: ramadan,
    });
    expect(period.status).toBe(201);
    const overlap = await c.post("/v1/operating-hours/periods", {
      name: "Lebaran",
      from: "2027-03-08",
      to: "2027-03-12",
      schedule: ramadan,
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe("operating_hours.overlap");
    const lebaran = await c.post("/v1/operating-hours/periods", {
      name: "Lebaran",
      from: "2027-03-09",
      to: "2027-03-12",
      schedule: [null, null, null, null, null, null, null],
    });
    expect(lebaran.status).toBe(201);
    expect((await c.patch(`/v1/operating-hours/periods/${lebaran.body.id}`, { from: "2027-03-01" })).status).toBe(409);
    expect((await c.patch(`/v1/operating-hours/periods/${lebaran.body.id}`, { to: "2027-03-01" })).status).toBe(422);
    const hours = await c.get("/v1/operating-hours");
    expect(hours.body.periods.map((p: { name: string }) => p.name)).toEqual(["Ramadan", "Lebaran"]);
    expect((await c.delete(`/v1/operating-hours/periods/${period.body.id}`)).status).toBe(204);
    expect((await c.delete("/v1/operating-hours/week")).status).toBe(204);
    expect((await c.get("/v1/operating-hours")).body.week).toBeNull();
  });

  it("is for whoever manages the warehouses", async () => {
    const { c: owner, me } = await signup(app);
    const email = uniqueEmail("cs");
    const roles = (await owner.get("/v1/roles")).body.items as { id: string; name: string }[];
    await owner.post("/v1/invitations", { email, roleId: roles.find((r) => r.name === "CS")!.id });
    await worker.runOutbox(me.tenant.id);
    const cs = client(app);
    const accepted = await cs.post("/v1/auth/invitations/accept", {
      token: tokenFrom(worker.email.lastTo(email)!.text),
      name: "Sari",
      password: PASSWORD,
    });
    expect(accepted.status).toBe(201);
    expect((await cs.get("/v1/courier-cutoffs")).status).toBe(403);
    expect((await cs.get("/v1/operating-hours")).status).toBe(403);
  });
});

describe("internal deadlines of orders (FR-CMP-05, 06)", () => {
  it("gives an order the courier cut-off it must make, again whenever the calendar changes", async () => {
    const { c, me } = await signup(app);
    const shop = await shopWithStock(c);
    const jnt = await manualOrder(c, shop, "J&T Express");
    const sicepat = await manualOrder(c, shop, "SiCepat");
    const gone = await manualOrder(c, shop, "J&T Express");
    // no cut-off yet: only the marketplace's deadline, if any
    expect(jnt.internalShipByAt).toBeNull();

    // ordered two days ago, paid yesterday morning: the seller's from the payment on
    await readyAt(jnt.id, wib(-1, "10:00"), wib(-2, "10:00"));
    await readyAt(gone.id, wib(-1, "10:00"));
    const cutoff = await c.post("/v1/courier-cutoffs", {
      warehouseId: shop.warehouseId,
      courier: "J&T",
      cutoffTime: "15:00",
      days: EVERY_DAY,
    });
    expect(cutoff.status).toBe(201);
    await worker.runOutbox(me.tenant.id);
    // ready yesterday morning: yesterday's 15:00 pickup, missed by now
    expect(await order(c, jnt.id)).toMatchObject({
      internalShipByAt: wib(-1, "15:00"),
      internalSla: { state: "missed" },
    });
    expect((await order(c, sicepat.id)).internalShipByAt).toBeNull();
    // an order that left the queue keeps the deadline it had, so it can be told later whether it made it
    expect((await c.post(`/v1/orders/${gone.id}/cancel`, { reason: "out_of_stock" })).status).toBeLessThan(300);

    // the courier did not come yesterday: today's pickup; another courier's holiday changes nothing
    await c.post("/v1/courier-holidays", {
      date: addDays(localDate("Asia/Jakarta", new Date()), -1),
      courier: "j&t express",
    });
    await c.post("/v1/courier-holidays", { date: localDate("Asia/Jakarta", new Date()), courier: "JNE" });
    await worker.runOutbox(me.tenant.id);
    expect((await order(c, jnt.id)).internalShipByAt).toBe(wib(0, "15:00"));

    // the business closes at noon: parcels are handed over before then
    await c.put("/v1/operating-hours/week", { schedule: EVERY_DAY.map(() => open("08:00", "12:00")) });
    await worker.runOutbox(me.tenant.id);
    expect((await order(c, jnt.id)).internalShipByAt).toBe(wib(0, "12:00"));

    // without the cut-off, the deadline goes
    await c.delete(`/v1/courier-cutoffs/${cutoff.body.id}`);
    await worker.runOutbox(me.tenant.id);
    expect((await order(c, jnt.id)).internalShipByAt).toBeNull();
    expect(await order(c, gone.id)).toMatchObject({ internalShipByAt: wib(-1, "15:00"), internalSla: null });
    // settling it again leaves it so too
    const ctx = userCtx(me.tenant.id, me.user.id);
    await withTenantTx(h.api, ctx, (tx) => app.get(OrderDeadlinesService).refreshIn(tx, ctx, [gone.id]));
    expect((await order(c, gone.id)).internalShipByAt).toBe(wib(-1, "15:00"));
  });

  it("sets it when an order comes in or moves warehouse, and sorts and filters the queue by it", async () => {
    const { c, me } = await signup(app);
    const shop = await shopWithStock(c);
    await c.post("/v1/courier-cutoffs", {
      warehouseId: shop.warehouseId,
      courier: "J&T Express",
      cutoffTime: "23:59",
      days: EVERY_DAY,
    });
    await worker.runOutbox(me.tenant.id);
    const sicepat = await manualOrder(c, shop, "SiCepat");
    const fresh = await manualOrder(c, shop, "J&T Express");
    // computed as the order comes in, today's last pickup or tomorrow's
    expect(fresh.internalShipByAt).not.toBeNull();
    expect([wib(0, "23:59"), wib(1, "23:59")]).toContain(fresh.internalShipByAt);

    // a second warehouse whose J&T pickup is at 10:00
    const sby = await c.post("/v1/warehouses", { code: "SBY", name: "Gudang Surabaya" });
    expect(sby.status).toBe(201);
    await c.post("/v1/courier-cutoffs", {
      warehouseId: sby.body.id,
      courier: "J&T",
      cutoffTime: "10:00",
      days: EVERY_DAY,
    });
    await worker.runOutbox(me.tenant.id);
    const late = await manualOrder(c, shop, "J&T Express");
    await readyAt(late.id, wib(-2, "09:00"));
    expect((await c.put(`/v1/orders/${late.id}/warehouse`, { warehouseId: sby.body.id })).status).toBe(204);
    expect((await order(c, late.id)).internalShipByAt).toBe(wib(-2, "10:00"));

    // the queue: the order that missed its pickup first, the one without a deadline last
    const queue = await c.get("/v1/orders?sort=ship_by&status=new,problem");
    const ids = (queue.body.items as { id: string }[]).map((o) => o.id);
    expect(ids[0]).toBe(late.id);
    expect(ids.at(-1)).toBe(sicepat.id);
    // paged one at a time, the same order
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { items: { id: string }[]; next_cursor: string | null } } = await c.get(
        `/v1/orders?sort=ship_by&status=new,problem&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      );
      paged.push(...page.body.items.map((o) => o.id));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(paged).toEqual(ids);

    // "harus dikirim sebelum cut-off hari ini": the missed one, and today's if its pickup is today
    const due = await c.get("/v1/orders?due=cutoff");
    const dueIds = (due.body.items as { id: string }[]).map((o) => o.id);
    expect(dueIds).toContain(late.id);
    expect(dueIds).not.toContain(sicepat.id);
    expect(dueIds.includes(fresh.id)).toBe(fresh.internalShipByAt === wib(0, "23:59"));

    const dashboard = await c.get("/v1/dashboard");
    const task = (dashboard.body.tasks as { kind: string; severity: string; title: string }[]).find(
      (t) => t.kind === "orders_cutoff",
    );
    expect(task).toMatchObject({ severity: "critical" });
    expect(task!.title).toMatch(/lewat cut-off/);

    const couriers = await c.get(`/v1/orders/couriers?warehouseId=${shop.warehouseId}`);
    expect(couriers.body.items).toEqual([
      { courier: "J&T Express", orders: 1 },
      { courier: "SiCepat", orders: 1 },
    ]);
  });
});
