import type { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDate } from "../../src/common/time-zone";
import { type Client, client, PASSWORD, signup, startApi, startWorker, tokenFrom, uniqueEmail } from "../setup/app";
import { testHandles } from "../setup/handles";

/**
 * Stock counts (stock opname) and stock transfers between warehouses end to end (backend doc 8.27; PRD
 * FR-STK-08, 09): counted blind by hand and by scanning, reviewed, approved, applied by the worker;
 * transfers sent, received with what went missing, and cancelled.
 */
const h = testHandles();
let api: INestApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  api = await startApi(h.infra);
  worker = await startWorker(h.infra, h.system);
});

afterAll(async () => {
  await worker?.close();
  await api?.close();
});

/** YYMM of documents numbered now in the business's time zone (Asia/Jakarta). */
const period = () => localDate("Asia/Jakarta", new Date()).slice(2, 7).replace("-", "");

async function drain(tenantId: string): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < 20; i++) {
    const round = await worker.runOutbox(tenantId);
    if (round.length === 0) break;
    ran.push(...round);
  }
  return ran;
}

/** A business with its first warehouse in Jakarta and a second one in Surabaya. */
async function business() {
  const { c, me } = await signup(api);
  const jakarta = (await c.get("/v1/warehouses")).body.items[0].id as string;
  const sby = await c.post("/v1/warehouses", { code: "SBY", name: "Gudang Surabaya" });
  expect(sby.status).toBe(201);
  return { c, me, tenantId: me.tenant.id, jakarta, surabaya: sby.body.id as string };
}

async function product(c: Client, sku: string, variantSkus: string[]) {
  const res = await c.post("/v1/products", {
    sku,
    name: `Produk ${sku}`,
    attributeNames: ["Ukuran"],
    variants: variantSkus.map((v, i) => ({
      sku: v,
      attributes: { Ukuran: String(i + 1) },
      basePrice: 50_000,
      costPrice: 20_000,
      weightG: 200,
    })),
  });
  expect(res.status).toBe(201);
  return Object.fromEntries((res.body.variants as { id: string; sku: string }[]).map((v) => [v.sku, v.id])) as Record<
    string,
    string
  >;
}

async function setStock(c: Client, warehouseId: string, lines: Record<string, number>) {
  const res = await c.post("/v1/inventory/adjustments", {
    lines: Object.entries(lines).map(([variantId, quantity]) => ({ variantId, warehouseId, mode: "set", quantity })),
    reason: "correction",
  });
  expect(res.status).toBe(200);
}

/** Moves stock by `delta` with a reason, as a stocker would between counting and approval. */
async function adjust(c: Client, warehouseId: string, variantId: string, delta: number) {
  const res = await c.post("/v1/inventory/adjustments", {
    lines: [{ variantId, warehouseId, mode: "delta", quantity: delta }],
    reason: "correction",
  });
  expect(res.status).toBe(200);
}

/** Jobs of the tenant's outbox not run yet, by job name. */
async function pendingJobs(tenantId: string, job: string): Promise<number> {
  const r = await h.system.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM outbox_event
         WHERE tenant_id = ${tenantId} AND job_name = ${job} AND published_at IS NULL`,
  );
  return r.rows[0]!.n;
}

type StockRow = { warehouseId: string; onHand: number; reserved: number; stockSetAt: string | null };

async function rowAt(c: Client, sku: string, warehouseId: string): Promise<StockRow | undefined> {
  const items = (await c.get(`/v1/inventory?q=${sku}`)).body.items as { sku: string; warehouses: StockRow[] }[];
  return items.find((i) => i.sku === sku)?.warehouses.find((r) => r.warehouseId === warehouseId);
}

/** On hand and reserved of a SKU in one warehouse. */
async function stockAt(c: Client, sku: string, warehouseId: string) {
  const row = await rowAt(c, sku, warehouseId);
  return { onHand: row?.onHand ?? 0, reserved: row?.reserved ?? 0 };
}

async function addMember(
  owner: Client,
  tenantId: string,
  role: string,
  scope?: { warehouseIds: string[] },
): Promise<{ c: Client; id: string }> {
  const roles = (await owner.get("/v1/roles")).body.items as { id: string; name: string }[];
  const email = uniqueEmail(role.toLowerCase());
  expect((await owner.post("/v1/invitations", { email, roleId: roles.find((r) => r.name === role)!.id })).status).toBe(
    201,
  );
  await drain(tenantId);
  const member = client(api);
  const accepted = await member.post("/v1/auth/invitations/accept", {
    token: tokenFrom(worker.email.lastTo(email)!.text),
    name: role,
    password: PASSWORD,
  });
  expect(accepted.status).toBe(201);
  const id = accepted.body.user.id as string;
  if (scope) expect((await owner.put(`/v1/users/${id}/scopes`, scope)).status).toBe(200);
  return { c: member, id };
}

type Notice = { kind: string; title: string; body: string; data: Record<string, unknown> };
const notices = async (c: Client, kind: string): Promise<Notice[]> =>
  ((await c.get("/v1/notifications")).body.items as Notice[]).filter((n) => n.kind === kind);

type LineBody = {
  id: string;
  sku: string;
  reserved: number | null;
  expectedQty: number | null;
  countedQty: number | null;
  diff: number | null;
  appliedDelta: number | null;
  countedBy: string | null;
};
const linesOf = async (c: Client, id: string, query = ""): Promise<LineBody[]> => {
  const res = await c.get(`/v1/stock-counts/${id}/lines${query}`);
  expect(res.status).toBe(200);
  return res.body.items;
};

describe("stock counts (FR-STK-08)", () => {
  it("counts a warehouse blind by hand and by scanning, is approved, and keeps what sold after the count", async () => {
    const { c, tenantId, jakarta, surabaya } = await business();
    const v = await product(c, "KAOS", ["KAOS-S", "KAOS-M", "KAOS-L", "KAOS-XL"]);
    await setStock(c, jakarta, { [v["KAOS-S"]!]: 10, [v["KAOS-M"]!]: 5, [v["KAOS-L"]!]: 3 });
    await setStock(c, surabaya, { [v["KAOS-S"]!]: 4 });
    for (const [sku, bin] of [
      ["KAOS-S", "R1-02"],
      ["KAOS-M", "R1-01"],
    ] as const) {
      expect((await c.put(`/v1/inventory/${v[sku]}/warehouses/${jakarta}`, { binLocation: bin })).status).toBe(200);
    }
    const [barcode] = (await c.post("/v1/products/barcodes", { variantIds: [v["KAOS-M"]] })).body.items as {
      barcode: string;
    }[];
    const gudang = await addMember(c, tenantId, "Gudang", { warehouseIds: [jakarta] });
    const admin = await addMember(c, tenantId, "Admin");
    const elsewhere = await addMember(c, tenantId, "Gudang", { warehouseIds: [surabaya] });

    // warehouse staff start a full count: every SKU the warehouse holds, rack by rack
    const started = await gudang.c.post("/v1/stock-counts", { warehouseId: jakarta, mode: "full" });
    expect(started.status).toBe(201);
    const number = `OP-${period()}-0001`;
    expect(started.body).toMatchObject({
      number,
      status: "counting",
      mode: "full",
      blind: true,
      warehouse: { id: jakarta, code: "UTAMA" },
      createdBy: gudang.id,
      stats: { lines: 3, counted: 0, differences: null, added: 0 },
      difference: null,
    });
    const id = started.body.id as string;
    const second = await c.post("/v1/stock-counts", { warehouseId: jakarta, mode: "full" });
    expect(second.body.code).toBe("stock_count.open_exists");
    expect(second.body.detail).toContain(number);
    // staff of another warehouse neither see it nor count this one
    expect((await elsewhere.c.get(`/v1/stock-counts/${id}`)).status).toBe(404);
    expect((await elsewhere.c.get("/v1/stock-counts")).body.items).toEqual([]);
    expect((await elsewhere.c.post("/v1/stock-counts", { warehouseId: jakarta, mode: "full" })).status).toBe(422);

    // blind: the system's quantity stays hidden while counting
    let lines = await linesOf(gudang.c, id);
    expect(lines.map((l) => l.sku)).toEqual(["KAOS-M", "KAOS-S", "KAOS-L"]);
    expect(lines[0]).toMatchObject({ binLocation: "R1-01", expectedQty: null, diff: null, countedQty: null });
    expect((await gudang.c.get(`/v1/stock-counts/${id}/lines?filter=differences`)).status).toBe(422);

    // by hand, by barcode, by SKU, and a SKU found on the shelf that the list does not have
    const byHand = await gudang.c.put(`/v1/stock-counts/${id}/lines`, {
      lines: [{ variantId: v["KAOS-S"], qty: 8, mode: "set" }],
    });
    expect(byHand.status).toBe(200);
    expect(byHand.body.items).toEqual([expect.objectContaining({ sku: "KAOS-S", countedQty: 8, expectedQty: null })]);
    const scanned = await gudang.c.post(`/v1/stock-counts/${id}/scan`, { code: barcode!.barcode });
    expect(scanned.body).toMatchObject({ matchedBy: "barcode", line: { sku: "KAOS-M", countedQty: 1 } });
    const bySku = await gudang.c.post(`/v1/stock-counts/${id}/scan`, { code: " kaos-m ", qty: 4 });
    expect(bySku.body).toMatchObject({
      matchedBy: "sku",
      line: { sku: "KAOS-M", countedQty: 5, countedBy: gudang.id },
    });
    const found = await gudang.c.post(`/v1/stock-counts/${id}/scan`, { code: "KAOS-XL" });
    expect(found.body.line).toMatchObject({ sku: "KAOS-XL", added: true, countedQty: 1, expectedQty: null });
    expect((await gudang.c.post(`/v1/stock-counts/${id}/scan`, { code: "TIDAK-ADA" })).body.errors).toEqual([
      { path: "code", message: "Barcode atau SKU ini tidak dikenal." },
    ]);
    expect(
      (
        await gudang.c.put(`/v1/stock-counts/${id}/lines`, {
          lines: [
            { variantId: v["KAOS-L"], qty: 1, mode: "set" },
            { variantId: v["KAOS-L"], qty: 2, mode: "add" },
          ],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await gudang.c.put(`/v1/stock-counts/${id}/lines`, {
          lines: [{ variantId: "01J00000000000000000000000", qty: 1, mode: "set" }],
        })
      ).body.errors,
    ).toEqual([{ path: "lines.0.variantId", message: "Varian produk tidak ditemukan." }]);

    // a sale at the counter after the count: one KAOS-S leaves the shelf before approval
    const counter = await c.post("/v1/stores/manual", { name: "Toko Offline" });
    const sale = await c.post("/v1/orders/manual", {
      storeId: counter.body.id,
      warehouseId: jakarta,
      buyer: { name: "Pembeli Toko" },
      items: [{ variantId: v["KAOS-S"], qty: 1 }],
      paymentMethod: "cod",
    });
    expect(sale.status).toBe(201);
    expect((await c.post(`/v1/orders/${sale.body.id}/complete`)).body.status).toBe("completed");
    expect(await stockAt(c, "KAOS-S", jakarta)).toEqual({ onHand: 9, reserved: 0 });

    // counting staff send it for review; approvers hear of it and see the difference
    expect((await gudang.c.post(`/v1/stock-counts/${id}/apply`, {})).status).toBe(403);
    const submitted = await gudang.c.post(`/v1/stock-counts/${id}/submit`);
    expect(submitted.body).toMatchObject({
      status: "review",
      submittedBy: gudang.id,
      stats: { lines: 4, counted: 3, differences: 2, added: 1 },
      difference: { unitsOver: 1, unitsUnder: 2, value: null },
    });
    expect((await admin.c.get(`/v1/stock-counts/${id}`)).body.difference).toEqual({
      unitsOver: 1,
      unitsUnder: 2,
      value: -20_000,
    });
    expect(await notices(admin.c, "stock_count.review")).toEqual([
      expect.objectContaining({
        title: `Stok opname ${number} menunggu persetujuan`,
        data: expect.objectContaining({ stockCountId: id }),
      }),
    ]);
    expect(await notices(gudang.c, "stock_count.review")).toEqual([]);
    expect(
      (await linesOf(admin.c, id, "?filter=differences")).map((l) => [l.sku, l.expectedQty, l.countedQty, l.diff]),
    ).toEqual([
      ["KAOS-S", 10, 8, -2],
      ["KAOS-XL", 0, 1, 1],
    ]);
    expect((await linesOf(admin.c, id, "?filter=uncounted")).map((l) => l.sku)).toEqual(["KAOS-L"]);
    // the reviewer sees units of open orders: maybe packed and off the shelf
    const held = await c.post("/v1/orders/manual", {
      storeId: counter.body.id,
      warehouseId: jakarta,
      buyer: { name: "Pembeli Kedua" },
      items: [{ variantId: v["KAOS-M"], qty: 1 }],
      paymentMethod: "cash",
    });
    expect(held.status).toBe(201);
    expect((await linesOf(admin.c, id)).find((l) => l.sku === "KAOS-M")).toMatchObject({ reserved: 1 });
    expect((await gudang.c.put(`/v1/stock-counts/${id}/lines`, { lines: [] })).status).toBe(422);
    expect(
      (await gudang.c.put(`/v1/stock-counts/${id}/lines`, { lines: [{ variantId: v["KAOS-L"], qty: 3, mode: "set" }] }))
        .body.code,
    ).toBe("stock_count.not_counting");

    // the approver sends it back: the counter finds a second KAOS-XL; KAOS-L stays uncounted
    expect((await gudang.c.post(`/v1/stock-counts/${id}/reopen`)).status).toBe(403);
    expect((await admin.c.post(`/v1/stock-counts/${id}/reopen`)).body.status).toBe("counting");
    await gudang.c.put(`/v1/stock-counts/${id}/lines`, { lines: [{ variantId: v["KAOS-XL"], qty: 2, mode: "set" }] });
    expect((await gudang.c.post(`/v1/stock-counts/${id}/submit`)).body.stats).toMatchObject({
      counted: 3,
      differences: 2,
    });

    // approved: the worker applies it; nothing can change it meanwhile
    await drain(tenantId);
    const approved = await admin.c.post(`/v1/stock-counts/${id}/apply`, {});
    expect(approved.status).toBe(202);
    expect(approved.body).toMatchObject({ status: "review", applyRequestedBy: admin.id, zeroUncounted: false });
    expect((await admin.c.post(`/v1/stock-counts/${id}/cancel`)).body.code).toBe("stock_count.apply_requested");
    expect((await admin.c.post(`/v1/stock-counts/${id}/reopen`)).body.code).toBe("stock_count.apply_requested");
    const ran = await drain(tenantId);
    expect(ran).toContain("stock_count.apply");
    expect(ran).toContain("stock.mark_dirty");
    const applied = (await c.get(`/v1/stock-counts/${id}`)).body;
    expect(applied.status).toBe("applied");
    expect(applied.appliedAt).not.toBeNull();

    // what the count found, keeping the sale made after it; the other warehouse untouched
    expect(await stockAt(c, "KAOS-S", jakarta)).toEqual({ onHand: 7, reserved: 0 });
    expect(await stockAt(c, "KAOS-M", jakarta)).toEqual({ onHand: 5, reserved: 1 });
    expect(await stockAt(c, "KAOS-L", jakarta)).toEqual({ onHand: 3, reserved: 0 });
    expect(await stockAt(c, "KAOS-XL", jakarta)).toEqual({ onHand: 2, reserved: 0 });
    expect(await stockAt(c, "KAOS-S", surabaya)).toEqual({ onHand: 4, reserved: 0 });
    expect((await rowAt(c, "KAOS-XL", jakarta))?.stockSetAt).not.toBeNull();
    lines = await linesOf(c, id);
    expect(lines.map((l) => [l.sku, l.appliedDelta])).toEqual([
      ["KAOS-M", 0],
      ["KAOS-S", -2],
      ["KAOS-L", null],
      ["KAOS-XL", 2],
    ]);
    const moves = (
      await c.get(`/v1/inventory/movements?variantId=${v["KAOS-S"]}&warehouseId=${jakarta}&type=count_apply`)
    ).body.items;
    expect(moves).toEqual([
      expect.objectContaining({
        onHandDelta: -2,
        onHandAfter: 7,
        referenceType: "stock_count_line",
        referenceId: lines[1]!.id,
        note: `Stok opname ${number}`,
        actorUserId: admin.id,
        document: { type: "stock_count", id, number },
      }),
    ]);
    // started, sent for review twice, reopened, approved, applied
    const audit = (await c.get(`/v1/audit-logs?entity_type=stock_count&entity_id=${id}`)).body.items as unknown[];
    expect(audit).toHaveLength(6);

    // the warehouse may be counted again
    const next = await gudang.c.post("/v1/stock-counts", { warehouseId: jakarta, mode: "full" });
    expect(next.body).toMatchObject({ number: `OP-${period()}-0002`, stats: { lines: 4 } });
    expect((await gudang.c.get("/v1/stock-counts?status=applied")).body.items.map((x: { id: string }) => x.id)).toEqual(
      [id],
    );
  });

  it("counts one rack and chosen SKUs, sets what nobody found to none, and cancels a count without touching stock", async () => {
    const { c, tenantId, jakarta } = await business();
    const v = await product(c, "TAS", ["TAS-1", "TAS-2", "TAS-3", "TAS-4", "TAS-5", "TAS-6"]);
    await setStock(c, jakarta, {
      [v["TAS-1"]!]: 6,
      [v["TAS-2"]!]: 4,
      [v["TAS-3"]!]: 2,
      [v["TAS-4"]!]: 9,
      [v["TAS-5"]!]: 5,
    });
    for (const [sku, bin] of [
      ["TAS-1", "B2-01"],
      ["TAS-2", "b2-02"],
      ["TAS-5", "B2-03"],
      ["TAS-3", "B3-01"],
    ] as const) {
      await c.put(`/v1/inventory/${v[sku]}/warehouses/${jakarta}`, { binLocation: bin });
    }

    expect((await c.post("/v1/stock-counts", { warehouseId: jakarta, mode: "partial" })).status).toBe(422);
    expect((await c.post("/v1/stock-counts", { warehouseId: jakarta, mode: "full", binPrefix: "B2" })).status).toBe(
      422,
    );
    expect(
      (await c.post("/v1/stock-counts", { warehouseId: jakarta, mode: "partial", binPrefix: "Z9" })).body.code,
    ).toBe("stock_count.empty");
    const unknown = await c.post("/v1/stock-counts", {
      warehouseId: jakarta,
      mode: "partial",
      variantIds: [v["TAS-1"], "01J00000000000000000000000"],
    });
    expect(unknown.body.errors).toEqual([{ path: "variantIds.1", message: "Varian produk tidak ditemukan." }]);

    // rack B2 (any case) and two chosen SKUs, one never stocked here; not blind
    const created = await c.post("/v1/stock-counts", {
      warehouseId: jakarta,
      mode: "partial",
      binPrefix: "B2",
      variantIds: [v["TAS-6"], v["TAS-4"], v["TAS-1"]],
      blind: false,
      note: "Rak B2 dan tas besar",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ mode: "partial", blind: false, note: "Rak B2 dan tas besar" });
    expect(created.body.stats).toEqual({ lines: 5, counted: 0, differences: 0, added: 0 });
    const id = created.body.id as string;
    expect((await linesOf(c, id)).map((l) => [l.sku, l.expectedQty])).toEqual([
      ["TAS-1", 6],
      ["TAS-2", 4],
      ["TAS-5", 5],
      ["TAS-4", 9],
      ["TAS-6", 0],
    ]);
    // search by rack (any case) and by SKU
    expect((await linesOf(c, id, "?q=b2-0")).map((l) => l.sku)).toEqual(["TAS-1", "TAS-2", "TAS-5"]);
    expect((await linesOf(c, id, "?q=tas-4")).map((l) => l.sku)).toEqual(["TAS-4"]);

    // `set` compares with the stock when the shelf was counted: one TAS-1 arrived before it was counted
    await adjust(c, jakarta, v["TAS-1"]!, 1);
    await c.put(`/v1/stock-counts/${id}/lines`, { lines: [{ variantId: v["TAS-1"], qty: 7, mode: "set" }] });
    // scanning compares with the stock at the first scan: two TAS-5 left while it was being scanned
    await c.post(`/v1/stock-counts/${id}/scan`, { code: "TAS-5" });
    await adjust(c, jakarta, v["TAS-5"]!, -2);
    const scanned = await c.post(`/v1/stock-counts/${id}/scan`, { code: "TAS-5", qty: 2 });
    expect(scanned.body.line).toMatchObject({ expectedQty: 5, countedQty: 3, diff: -2 });
    await c.put(`/v1/stock-counts/${id}/lines`, { lines: [{ variantId: v["TAS-6"], qty: 0, mode: "set" }] });
    // one TAS-4 arrives after listing; TAS-2 and TAS-4 are never counted
    await adjust(c, jakarta, v["TAS-4"]!, 1);
    expect((await c.post(`/v1/stock-counts/${id}/submit`)).body.stats).toMatchObject({ counted: 3, differences: 1 });

    // the approver counts what nobody found as none; asking again keeps the first choice
    const approved = await c.post(`/v1/stock-counts/${id}/apply`, { zeroUncounted: true });
    expect(approved.body.zeroUncounted).toBe(true);
    const again = await c.post(`/v1/stock-counts/${id}/apply`, { zeroUncounted: false });
    expect(again.status).toBe(202);
    expect(again.body.zeroUncounted).toBe(true);
    expect(await pendingJobs(tenantId, "stock_count.apply")).toBe(2);
    await drain(tenantId);
    expect((await c.get(`/v1/stock-counts/${id}`)).body.status).toBe("applied");
    expect(await stockAt(c, "TAS-1", jakarta)).toEqual({ onHand: 7, reserved: 0 });
    expect(await stockAt(c, "TAS-2", jakarta)).toEqual({ onHand: 0, reserved: 0 });
    expect(await stockAt(c, "TAS-3", jakarta)).toEqual({ onHand: 2, reserved: 0 });
    expect(await stockAt(c, "TAS-4", jakarta)).toEqual({ onHand: 0, reserved: 0 });
    expect(await stockAt(c, "TAS-5", jakarta)).toEqual({ onHand: 1, reserved: 0 });
    // a count of none where nothing was recorded confirms it: the stock is established now
    expect(await rowAt(c, "TAS-6", jakarta)).toMatchObject({ onHand: 0, stockSetAt: expect.any(String) });
    expect(
      (await linesOf(c, id)).map((l) => [l.sku, l.expectedQty, l.countedQty, l.diff, l.appliedDelta, l.countedBy]),
    ).toEqual([
      ["TAS-1", 7, 7, 0, 0, expect.any(String)],
      ["TAS-2", 4, 0, -4, -4, null],
      ["TAS-5", 5, 3, -2, -2, expect.any(String)],
      ["TAS-4", 10, 0, -10, -10, null],
      ["TAS-6", 0, 0, 0, 0, expect.any(String)],
    ]);
    expect((await c.post(`/v1/stock-counts/${id}/apply`, {})).body.code).toBe("stock_count.not_in_review");

    // a count stopped before approval changes nothing
    const stopped = await c.post("/v1/stock-counts", { warehouseId: jakarta, mode: "partial", binPrefix: "B3" });
    await c.put(`/v1/stock-counts/${stopped.body.id}/lines`, {
      lines: [{ variantId: v["TAS-3"], qty: 0, mode: "set" }],
    });
    const cancelled = await c.post(`/v1/stock-counts/${stopped.body.id}/cancel`);
    expect(cancelled.body.status).toBe("cancelled");
    expect((await c.post(`/v1/stock-counts/${stopped.body.id}/cancel`)).body.code).toBe("stock_count.closed");
    expect((await c.post(`/v1/stock-counts/${stopped.body.id}/submit`)).body.code).toBe("stock_count.not_counting");
    await drain(tenantId);
    expect(await stockAt(c, "TAS-3", jakarta)).toEqual({ onHand: 2, reserved: 0 });

    // a full count lists archived SKUs only while they still hold stock
    const productId = (await c.get("/v1/products?q=TAS")).body.items[0].id as string;
    for (const sku of ["TAS-2", "TAS-3"]) {
      const archived = await c.patch(`/v1/products/${productId}/variants/${v[sku]}`, { status: "archived" });
      expect(archived.status).toBe(200);
    }
    const full = await c.post("/v1/stock-counts", { warehouseId: jakarta, mode: "full", blind: false });
    expect(full.status).toBe(201);
    expect((await linesOf(c, full.body.id)).map((l) => [l.sku, l.expectedQty])).toEqual([
      ["TAS-1", 7],
      ["TAS-5", 1],
      ["TAS-3", 2],
      ["TAS-4", 0],
      ["TAS-6", 0],
    ]);
  });
});

describe("stock transfers between warehouses (FR-STK-09)", () => {
  it("sends what is available, receives what arrived, and puts a cancelled transfer back", async () => {
    const { c, tenantId, jakarta, surabaya } = await business();
    const v = await product(c, "SPT", ["SPT-40", "SPT-41", "SPT-42"]);
    await setStock(c, jakarta, { [v["SPT-40"]!]: 10, [v["SPT-41"]!]: 5 });
    const jkt = await addMember(c, tenantId, "Gudang", { warehouseIds: [jakarta] });
    const sby = await addMember(c, tenantId, "Gudang", { warehouseIds: [surabaya] });

    // the sender may pick a destination outside its scope, and must hold the origin
    expect(
      ((await jkt.c.get("/v1/stock-transfers/destinations")).body.items as { id: string }[]).map((w) => w.id).sort(),
    ).toEqual([jakarta, surabaya].sort());
    const lines = [
      { variantId: v["SPT-40"], qty: 3 },
      { variantId: v["SPT-41"], qty: 8 },
    ];
    expect(
      (await sby.c.post("/v1/stock-transfers", { fromWarehouseId: jakarta, toWarehouseId: surabaya, lines })).body
        .errors,
    ).toEqual([expect.objectContaining({ path: "fromWarehouseId" })]);
    expect(
      (await jkt.c.post("/v1/stock-transfers", { fromWarehouseId: jakarta, toWarehouseId: jakarta, lines })).body
        .errors,
    ).toEqual([{ path: "toWarehouseId", message: "Gudang tujuan harus berbeda dari gudang asal." }]);
    expect(
      (
        await jkt.c.post("/v1/stock-transfers", {
          fromWarehouseId: jakarta,
          toWarehouseId: surabaya,
          lines: [lines[0], lines[0]],
        })
      ).body.errors,
    ).toEqual([{ path: "lines.1.variantId", message: "SKU ini disebut dua kali." }]);

    const body = { fromWarehouseId: jakarta, toWarehouseId: surabaya, note: "Isi stok Surabaya", lines };
    const created = await jkt.c.post("/v1/stock-transfers", body).set("Idempotency-Key", "tf-sby-0001");
    expect(created.status).toBe(201);
    const number = `TF-${period()}-0001`;
    expect(created.body).toMatchObject({
      number,
      status: "draft",
      from: { id: jakarta },
      to: { id: surabaya, name: "Gudang Surabaya" },
      units: 11,
      createdBy: jkt.id,
      lines: [
        { sku: "SPT-40", qty: 3, receivedQty: null, missingQty: null },
        { sku: "SPT-41", qty: 8 },
      ],
    });
    const again = await jkt.c.post("/v1/stock-transfers", body).set("Idempotency-Key", "tf-sby-0001");
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.id).toBe(created.body.id);
    const id = created.body.id as string;

    // only stock available at the origin leaves: an order holds 8 of SPT-40, and SPT-41 has 5
    const counter = await c.post("/v1/stores/manual", { name: "Toko Offline" });
    const order = await c.post("/v1/orders/manual", {
      storeId: counter.body.id,
      warehouseId: jakarta,
      buyer: { name: "Pembeli Toko" },
      items: [{ variantId: v["SPT-40"], qty: 8 }],
      paymentMethod: "cash",
    });
    expect(order.status).toBe(201);
    const short = await jkt.c.post(`/v1/stock-transfers/${id}/send`);
    expect(short.status).toBe(422);
    expect(short.body.errors).toEqual([
      { path: "lines.0.qty", message: "Stok tersedia di gudang asal hanya 2." },
      { path: "lines.1.qty", message: "Stok tersedia di gudang asal hanya 5." },
    ]);
    expect(await stockAt(c, "SPT-40", jakarta)).toEqual({ onHand: 10, reserved: 8 });
    expect((await c.post(`/v1/orders/${order.body.id}/cancel`, { reason: "buyer_request" })).status).toBe(202);
    expect(await stockAt(c, "SPT-40", jakarta)).toEqual({ onHand: 10, reserved: 0 });

    // the draft is corrected; a stale version is refused
    expect((await jkt.c.patch(`/v1/stock-transfers/${id}`, { note: "x" }).set("If-Match", '"99"')).body.code).toBe(
      "row.stale",
    );
    const patched = await jkt.c
      .patch(`/v1/stock-transfers/${id}`, {
        lines: [
          { variantId: v["SPT-40"], qty: 3 },
          { variantId: v["SPT-41"], qty: 5 },
        ],
      })
      .set("If-Match", `"${created.body.rowVersion}"`);
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ units: 8, rowVersion: created.body.rowVersion + 1 });

    // the destination's staff see it but do not send it
    expect((await sby.c.get(`/v1/stock-transfers/${id}`)).status).toBe(200);
    expect((await sby.c.post(`/v1/stock-transfers/${id}/send`)).body.code).toBe("stock_transfer.origin_only");
    await drain(tenantId);
    const sent = await jkt.c.post(`/v1/stock-transfers/${id}/send`);
    expect(sent.status).toBe(200);
    expect(await drain(tenantId)).toContain("stock.mark_dirty");
    expect(sent.body).toMatchObject({ status: "sent", sentBy: jkt.id });
    expect(await stockAt(c, "SPT-40", jakarta)).toEqual({ onHand: 7, reserved: 0 });
    expect(await stockAt(c, "SPT-41", jakarta)).toEqual({ onHand: 0, reserved: 0 });
    expect(await notices(sby.c, "stock_transfer.sent")).toEqual([
      expect.objectContaining({ title: `Transfer ${number} dikirim ke Gudang Surabaya` }),
    ]);
    expect(await notices(jkt.c, "stock_transfer.sent")).toEqual([]);
    expect((await jkt.c.patch(`/v1/stock-transfers/${id}`, { note: "x" })).body.code).toBe("stock_transfer.not_draft");
    expect((await jkt.c.post(`/v1/stock-transfers/${id}/send`)).body.code).toBe("stock_transfer.not_draft");
    expect((await jkt.c.post(`/v1/stock-transfers/${id}/receive`, {})).body.code).toBe(
      "stock_transfer.destination_only",
    );

    // one pair did not arrive; the rest is on hand at the destination, not yet counted there
    const lineIds = (sent.body.lines as { id: string }[]).map((l) => l.id);
    expect(
      (await sby.c.post(`/v1/stock-transfers/${id}/receive`, { lines: [{ lineId: lineIds[0], receivedQty: 4 }] })).body
        .errors,
    ).toEqual([{ path: "lines.0.receivedQty", message: "Paling banyak 3, sebanyak yang dikirim." }]);
    const received = await sby.c.post(`/v1/stock-transfers/${id}/receive`, {
      lines: [{ lineId: lineIds[0], receivedQty: 2 }],
      note: "1 pasang tidak ada",
    });
    expect(received.status).toBe(200);
    expect(await drain(tenantId)).toContain("stock.mark_dirty");
    expect(received.body).toMatchObject({
      status: "received",
      receivedBy: sby.id,
      receiptNote: "1 pasang tidak ada",
      lines: [
        { qty: 3, receivedQty: 2, missingQty: 1 },
        { qty: 5, receivedQty: 5, missingQty: 0 },
      ],
    });
    expect(await stockAt(c, "SPT-40", surabaya)).toEqual({ onHand: 2, reserved: 0 });
    expect(await stockAt(c, "SPT-41", surabaya)).toEqual({ onHand: 5, reserved: 0 });
    expect((await rowAt(c, "SPT-40", surabaya))?.stockSetAt).toBeNull();
    expect((await rowAt(c, "SPT-40", jakarta))?.stockSetAt).not.toBeNull();
    const out = (
      await c.get(`/v1/inventory/movements?variantId=${v["SPT-40"]}&warehouseId=${jakarta}&type=transfer_out`)
    ).body.items;
    expect(out).toEqual([
      expect.objectContaining({
        onHandDelta: -3,
        referenceType: "stock_transfer_line",
        referenceId: lineIds[0],
        note: `Transfer ${number}`,
        actorUserId: jkt.id,
        document: { type: "stock_transfer", id, number },
      }),
    ]);
    expect((await sby.c.post(`/v1/stock-transfers/${id}/receive`, {})).body.code).toBe("stock_transfer.not_sent");
    expect((await jkt.c.post(`/v1/stock-transfers/${id}/cancel`)).body.code).toBe("stock_transfer.closed");
    expect((await sby.c.get("/v1/stock-transfers?direction=in")).body.items.map((t: { id: string }) => t.id)).toEqual([
      id,
    ]);
    expect((await sby.c.get("/v1/stock-transfers?direction=out")).body.items).toEqual([]);

    // a sent transfer cancelled: its goods are back at the origin; open transfers keep both warehouses
    const second = await jkt.c.post("/v1/stock-transfers", {
      fromWarehouseId: jakarta,
      toWarehouseId: surabaya,
      lines: [{ variantId: v["SPT-40"], qty: 4 }],
    });
    expect(second.body.number).toBe(`TF-${period()}-0002`);
    expect((await jkt.c.post(`/v1/stock-transfers/${second.body.id}/send`)).status).toBe(200);
    expect(await stockAt(c, "SPT-40", jakarta)).toEqual({ onHand: 3, reserved: 0 });
    const kept = await c.delete(`/v1/warehouses/${surabaya}`);
    expect(kept.body.code).toBe("warehouse.has_open_documents");
    expect(kept.body.detail).toContain("1 transfer stok");
    await drain(tenantId);
    const back = await jkt.c.post(`/v1/stock-transfers/${second.body.id}/cancel`);
    expect(back.body).toMatchObject({ status: "cancelled", cancelledBy: jkt.id });
    expect(await drain(tenantId)).toContain("stock.mark_dirty");
    expect(await stockAt(c, "SPT-40", jakarta)).toEqual({ onHand: 7, reserved: 0 });
    expect(await stockAt(c, "SPT-40", surabaya)).toEqual({ onHand: 2, reserved: 0 });

    // a draft is simply dropped
    const third = await jkt.c.post("/v1/stock-transfers", {
      fromWarehouseId: jakarta,
      toWarehouseId: surabaya,
      lines: [{ variantId: v["SPT-42"], qty: 1 }],
    });
    expect((await jkt.c.post(`/v1/stock-transfers/${third.body.id}/cancel`)).body.status).toBe("cancelled");
    expect((await c.get("/v1/stock-transfers?status=cancelled")).body.items).toHaveLength(2);
    // closed transfers no longer hold the warehouse; its stock still does
    expect((await c.delete(`/v1/warehouses/${surabaya}`)).body.code).toBe("warehouse.has_stock");
    const audit = (await c.get(`/v1/audit-logs?entity_type=stock_transfer&entity_id=${id}`)).body.items as unknown[];
    expect(audit).toHaveLength(3);
  });
});
