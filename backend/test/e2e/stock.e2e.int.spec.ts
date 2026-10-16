import type { INestApplication } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { STOCK_DIRTY } from "../../src/infra/tokens";
import type { StockDirtySet } from "../../src/jobs/stock-dirty";
import { stockPushJob } from "../../src/modules/inventory/inventory.jobs";
import { executeOps } from "../../src/ops/execute";
import { parseOpsCommand } from "../../src/ops/ops-plan";
import { type Client, signup, startApi, startWorker } from "../setup/app";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace, type MockShopeeItem, type MockTiktokProduct } from "../setup/mock-marketplace";

/**
 * Stock end to end (PRD 6.3, 6.3.1; backend doc 9.4): adjustments and the stock card, initial stock
 * from a store, and the stock pusher against the fake Shopee and TikTok Shop, which enforce the
 * documented update_stock and Update Inventory rules.
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 900000;

beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
});

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await mock?.close();
});

async function drain(tenantId: string): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < 10; i++) {
    const round = await worker.runOutbox(tenantId);
    if (round.length === 0) break;
    ran.push(...round);
  }
  return ran;
}

/** Outbox, then the scheduler's flush and the stock.push jobs, as the processes would run them. */
async function push(tenantId: string) {
  await drain(tenantId);
  return worker.flushStock(tenantId);
}

async function business() {
  const { c, me } = await signup(api);
  const warehouseId = (await c.get("/v1/warehouses")).body.items[0].id as string;
  return { c, me, tenantId: me.tenant.id, warehouseId };
}

async function product(c: Client, sku: string, variantSkus: string[], costPrice = 10_000) {
  const res = await c.post("/v1/products", {
    sku,
    name: `Produk ${sku}`,
    variants: variantSkus.map((v) => ({ sku: v, basePrice: 50_000, costPrice, weightG: 200 })),
  });
  expect(res.status).toBe(201);
  return Object.fromEntries((res.body.variants as { id: string; sku: string }[]).map((v) => [v.sku, v.id]));
}

async function connectShopee(c: Client, tenantId: string, items: MockShopeeItem[], warehouses?: object[]) {
  const shopId = String(++shopSeq);
  mock.addShopeeShop({
    shopId,
    name: `Toko ${shopId}`,
    region: "ID",
    warehouses: (warehouses as never) ?? "not_whitelisted",
    items,
  });
  const started = await c.post("/v1/store-authorizations", { channel: "shopee" });
  await c.post("/v1/store-authorizations/callback", {
    channel: "shopee",
    state: new URL(started.body.authorizeUrl).searchParams.get("state"),
    code: mock.shopeeCode({ shopId }),
    shopId,
  });
  await drain(tenantId);
  const done = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body;
  return { shopId, storeId: done.result.stores[0].storeId as string };
}

async function goLive(c: Client, storeId: string) {
  const res = await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" });
  expect(res.status).toBe(200);
}

const shopeeUpdates = () => mock.callsTo("POST", "/api/v2/product/update_stock");
const bodyOf = <T>(call: { body: string }) => JSON.parse(call.body) as T;
type ShopeeBody = {
  item_id: number;
  stock_list: { model_id: number; seller_stock: { location_id?: string; stock: number }[] }[];
};

describe("stock adjustments and the stock card (FR-STK-05, 06)", () => {
  it("adjusts with a reason, all lines or none, and confirms an unchanged count", async () => {
    const { c, me, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L", "KAOS-XL"], 30_000);

    const noReason = await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 10 }],
    });
    expect(noReason.status).toBe(422);
    const otherWithoutNote = await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 10 }],
      reason: "other",
    });
    expect(otherWithoutNote.body.errors[0].path).toBe("note");

    const ok = await c.post("/v1/inventory/adjustments", {
      lines: [
        { variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 10 },
        { variantId: v["KAOS-L"], warehouseId, mode: "delta", quantity: 4 },
      ],
      reason: "correction",
      note: "hitung awal",
    });
    expect(ok.status).toBe(200);
    expect(
      ok.body.items.map((i: { onHandBefore: number; onHandAfter: number; changed: boolean }) => [
        i.onHandBefore,
        i.onHandAfter,
        i.changed,
      ]),
    ).toEqual([
      [0, 10, true],
      [0, 4, true],
    ]);

    // the second line would go below zero: nothing is changed, not even the first line
    const tooMuch = await c.post("/v1/inventory/adjustments", {
      lines: [
        { variantId: v["KAOS-M"], warehouseId, mode: "delta", quantity: -1 },
        { variantId: v["KAOS-L"], warehouseId, mode: "delta", quantity: -5 },
      ],
      reason: "damaged",
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.errors[0].path).toBe("lines.1.quantity");
    const duplicate = await c.post("/v1/inventory/adjustments", {
      lines: [
        { variantId: v["KAOS-M"], warehouseId, mode: "delta", quantity: 1 },
        { variantId: v["KAOS-M"], warehouseId, mode: "delta", quantity: 1 },
      ],
      reason: "correction",
    });
    expect(duplicate.body.errors[0].path).toBe("lines.1");

    const same = await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 10 }],
      reason: "correction",
    });
    expect(same.body.items[0]).toMatchObject({ changed: false, movementId: null, onHandAfter: 10 });

    const card = (await c.get(`/v1/inventory/movements?variantId=${v["KAOS-M"]}`)).body.items;
    expect(card).toHaveLength(1);
    expect(card[0]).toMatchObject({
      type: "adjustment",
      onHandDelta: 10,
      onHandAfter: 10,
      availableAfter: 10,
      reason: "correction",
      reasonLabel: "Koreksi",
      note: "hitung awal",
      referenceType: "manual",
      actorUserId: me.user.id,
    });

    const minimum = await c.put(`/v1/inventory/${v["KAOS-L"]}/warehouses/${warehouseId}`, {
      minStock: 5,
      binLocation: " A-01-03 ",
    });
    expect(minimum.body).toMatchObject({ minStock: 5, binLocation: "A-01-03", onHand: 4 });

    const ids = async (query: string) =>
      ((await c.get(`/v1/inventory${query}`)).body.items as { id: string }[]).map((i) => i.id).sort();
    expect(await ids("?stock=low")).toEqual([v["KAOS-L"]]);
    expect(await ids("?stock=out")).toEqual([v["KAOS-XL"]]);
    expect(await ids("?stock=unset")).toEqual([v["KAOS-XL"]]);
    expect(await ids("?q=kaos-m")).toEqual([v["KAOS-M"]]);

    const row = (await c.get("/v1/inventory?q=KAOS-M")).body.items[0];
    expect(row).toMatchObject({ sku: "KAOS-M", available: 10, established: true, push: [] });
    expect(row.warehouses[0]).toMatchObject({ warehouseId, onHand: 10, reserved: 0, available: 10 });

    expect((await c.get("/v1/inventory/summary")).body).toEqual({
      skus: 3,
      low: 1,
      out: 1,
      negative: 0,
      unset: 1,
      value: 14 * 30_000,
    });
  });
});

describe("stock push to Shopee (FR-STK-03, FR-WHS-04, 05, FR-MIG-05)", () => {
  it("repairs an externally changed marketplace stock through the ops outbox without changing local stock", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "OPS-REPAIR", ["OPS-REPAIR-1"]);
    const variantId = v["OPS-REPAIR-1"]!;
    const { shopId, storeId } = await connectShopee(c, tenantId, [
      {
        item_id: 599,
        item_name: "Tas",
        item_sku: "OPS-REPAIR-1",
        item_status: "NORMAL",
        update_time: 1_700_000_000,
        price: 50_000,
        stockByLocation: { "": 2 },
      },
    ]);
    await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId, warehouseId, mode: "set", quantity: 9 }],
      reason: "correction",
    });
    await goLive(c, storeId);
    expect((await push(tenantId)).errors).toEqual([]);
    const item = mock.shopeeShops.get(shopId)!.items![0]!;
    expect(item.stockByLocation).toEqual({ "": 9 });
    // Another application changed Shopee. OmniSeller's last-sent state still says 9.
    item.stockByLocation = { "": 1 };
    const command = parseOpsCommand([
      "stock:push",
      "--tenant",
      tenantId,
      "--variant",
      variantId,
      "--warehouse",
      warehouseId,
    ]);
    await executeOps(command, { worker: h.worker }, { NODE_ENV: "test" });
    expect((await push(tenantId)).errors).toEqual([]);
    expect(item.stockByLocation).toEqual({ "": 9 });
    expect((await c.get("/v1/inventory?q=OPS-REPAIR-1")).body.items[0].warehouses[0].onHand).toBe(9);
    expect((await c.get(`/v1/inventory/movements?variantId=${variantId}`)).body.items).toHaveLength(1);
    // Repair is still refused by the normal push planner while the store is read-only.
    await c.patch(`/v1/stores/${storeId}`, { syncMode: "read_only" });
    item.stockByLocation = { "": 3 };
    await executeOps(command, { worker: h.worker }, { NODE_ENV: "test" });
    expect((await push(tenantId)).errors).toEqual([]);
    expect(item.stockByLocation).toEqual({ "": 3 });
  });

  it("pushes nothing while read-only, everything once live, then only what changed", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    const t = await product(c, "TOPI", ["TOPI-1"]);
    await product(c, "GELANG", ["GELANG-1"]); // mapped but never counted
    const { storeId, shopId } = await connectShopee(c, tenantId, [
      {
        item_id: 501,
        item_name: "Kaos",
        item_sku: "KAOS",
        item_status: "NORMAL",
        update_time: 1_700_000_000,
        tiers: [{ name: "Ukuran", options: ["M", "L"] }],
        models: [
          { model_id: 11, model_sku: "KAOS-M", tier_index: [0], price: 50_000, stock: 3 },
          { model_id: 12, model_sku: "KAOS-L", tier_index: [1], price: 50_000, stock: 3 },
        ],
      },
      // stock without a location: the update must keep it that way
      {
        item_id: 502,
        item_name: "Topi",
        item_sku: "TOPI-1",
        item_status: "NORMAL",
        update_time: 1_700_000_000,
        price: 30_000,
        stockByLocation: { "": 9 },
      },
      {
        item_id: 503,
        item_name: "Gelang",
        item_sku: "GELANG-1",
        item_status: "NORMAL",
        update_time: 1_700_000_000,
        price: 10_000,
        stock: 8,
      },
    ]);
    const mapped = (await c.get(`/v1/listings?storeId=${storeId}&mapped=true`)).body.items;
    expect(mapped).toHaveLength(4);

    await c.post("/v1/inventory/adjustments", {
      lines: [
        { variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 10 },
        { variantId: v["KAOS-L"], warehouseId, mode: "set", quantity: 0 },
        { variantId: t["TOPI-1"], warehouseId, mode: "set", quantity: 6 },
      ],
      reason: "correction",
    });
    // read-only (parallel mode): not a single push request
    expect((await push(tenantId)).errors).toEqual([]);
    expect(shopeeUpdates().filter((x) => x.query.shop_id === shopId)).toHaveLength(0);
    const paused = (await c.get("/v1/inventory?q=KAOS-M")).body.items[0].push;
    expect(paused).toMatchObject([{ storeId, state: "paused", channelName: "Shopee" }]);

    await goLive(c, storeId);
    expect((await push(tenantId)).errors).toEqual([]);
    const sent = shopeeUpdates()
      .filter((x) => x.query.shop_id === shopId)
      .map((x) => bodyOf<ShopeeBody>(x))
      .sort((a, b) => a.item_id - b.item_id);
    // GELANG-1 was never counted, so its marketplace stock is left alone
    expect(sent).toEqual([
      {
        item_id: 501,
        stock_list: [
          { model_id: 11, seller_stock: [{ location_id: "IDZ", stock: 10 }] },
          { model_id: 12, seller_stock: [{ location_id: "IDZ", stock: 0 }] },
        ],
      },
      { item_id: 502, stock_list: [{ model_id: 0, seller_stock: [{ stock: 6 }] }] },
    ]);
    const shop = mock.shopeeShops.get(shopId)!;
    expect(shop.items!.find((i) => i.item_id === 503)!.stock).toBe(8);
    expect(shop.items!.find((i) => i.item_id === 502)!.stockByLocation).toEqual({ "": 6 });

    const synced = (await c.get("/v1/inventory?q=KAOS-M")).body.items[0].push[0];
    expect(synced).toMatchObject({ state: "synced", failCount: 0, lastError: null });
    expect(synced.lastPushedAt).not.toBeNull();
    const log = (await c.get(`/v1/stores/${storeId}/sync-jobs`)).body.items.filter(
      (j: { kind: string }) => j.kind === "stock.push",
    );
    expect(log[0]).toMatchObject({ status: "succeeded", direction: "push" });

    // nothing changed: nothing is sent, even when the pairs are marked again
    const before = shopeeUpdates().length;
    const dirty = worker.ctx.get<StockDirtySet>(STOCK_DIRTY);
    await dirty.markMany(tenantId, [{ variantId: v["KAOS-M"]!, warehouseId }]);
    await push(tenantId);
    expect(shopeeUpdates()).toHaveLength(before);

    // one variant changes: one call with that model only
    await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["KAOS-M"], warehouseId, mode: "delta", quantity: -2 }],
      reason: "sample",
    });
    await push(tenantId);
    const last = shopeeUpdates().slice(before);
    expect(last.map((x) => bodyOf<ShopeeBody>(x))).toEqual([
      { item_id: 501, stock_list: [{ model_id: 11, seller_stock: [{ location_id: "IDZ", stock: 8 }] }] },
    ]);

    // a seller warehouse appears unmapped (FR-WHS-04): the store is paused until it is mapped
    await withTenantTx(h.worker, userCtx(tenantId), (tx) =>
      tx.execute(sql`INSERT INTO channel_warehouse (id, tenant_id, store_id, external_warehouse_id, name, kind, last_seen_at)
                     VALUES (${newId()}, ${tenantId}, ${storeId}, 'IDX', 'Gudang baru', 'seller', now())`),
    );
    await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["KAOS-M"], warehouseId, mode: "delta", quantity: -1 }],
      reason: "sample",
    });
    const count = shopeeUpdates().length;
    await push(tenantId);
    expect(shopeeUpdates()).toHaveLength(count);
  });

  it("takes initial stock from the store, only where nobody has set it", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    const { storeId } = await connectShopee(c, tenantId, [
      {
        item_id: 601,
        item_name: "Kaos",
        item_sku: "KAOS",
        item_status: "NORMAL",
        update_time: 1_700_000_000,
        tiers: [{ name: "Ukuran", options: ["M", "L"] }],
        models: [
          { model_id: 21, model_sku: "KAOS-M", tier_index: [0], price: 50_000, stock: 7 },
          { model_id: 22, model_sku: "KAOS-L", tier_index: [1], price: 50_000, stock: 4 },
        ],
      },
    ]);
    await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["KAOS-L"], warehouseId, mode: "set", quantity: 2 }],
      reason: "correction",
    });

    const preview = await c.post("/v1/inventory/initial-stock", { storeId, dryRun: true });
    expect(preview.status).toBe(200);
    expect(
      preview.body.lines.map((l: { sku: string; marketplaceQty: number; onHandAfter: number; status: string }) => [
        l.sku,
        l.marketplaceQty,
        l.onHandAfter,
        l.status,
      ]),
    ).toEqual([
      ["KAOS-L", 4, 2, "already_set"],
      ["KAOS-M", 7, 7, "set"],
    ]);
    expect((await c.get("/v1/inventory?q=KAOS-M")).body.items[0].established).toBe(false);

    const applied = await c.post("/v1/inventory/initial-stock", { storeId });
    expect(applied.body.dryRun).toBe(false);
    const row = (await c.get("/v1/inventory?q=KAOS-M")).body.items[0];
    expect(row).toMatchObject({ available: 7, established: true });
    const card = (await c.get(`/v1/inventory/movements?variantId=${v["KAOS-M"]}`)).body.items;
    expect(card[0]).toMatchObject({ type: "migration_initial", onHandDelta: 7 });
    expect(card[0].note).toMatch(/^Stok awal dari Toko /);
    const again = await c.post("/v1/inventory/initial-stock", { storeId });
    expect(again.body.lines.every((l: { status: string }) => l.status === "already_set")).toBe(true);

    const other = await business();
    expect((await other.c.post("/v1/inventory/initial-stock", { storeId })).status).toBe(404);
  });

  it("retries a busy marketplace and records a refusal without retrying it", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M"]);
    const p = await product(c, "PROMO", ["PROMO-1"]);
    const { storeId, shopId } = await connectShopee(c, tenantId, [
      {
        item_id: 701,
        item_name: "Kaos",
        item_sku: "KAOS-M",
        item_status: "NORMAL",
        update_time: 1_700_000_000,
        price: 1,
        stock: 1,
      },
      // under promotion: Shopee refuses stock below the reserved quantity
      {
        item_id: 702,
        item_name: "Promo",
        item_sku: "PROMO-1",
        item_status: "NORMAL",
        update_time: 1_700_000_000,
        price: 1,
        stock: 9,
        reservedStock: 5,
      },
    ]);
    await goLive(c, storeId);
    await c.post("/v1/inventory/adjustments", {
      lines: [
        { variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 3 },
        { variantId: p["PROMO-1"], warehouseId, mode: "set", quantity: 2 },
      ],
      reason: "correction",
    });
    mock.failNext("POST", "/api/v2/product/update_stock", 500, {
      error: "error_server",
      message: "Something wrong. Please try later.",
    });
    const first = await push(tenantId);
    expect(first.errors).toHaveLength(1); // stock.push failed: BullMQ will retry it

    const state = async (sku: string) => (await c.get(`/v1/inventory?q=${sku}`)).body.items[0].push[0];
    const failing = [await state("KAOS-M"), await state("PROMO-1")];
    expect(failing.filter((s) => s.state === "failed")).toHaveLength(2);
    const busy = failing.find((s) => s.lastError?.includes("Something wrong"));
    expect(busy).toMatchObject({ failCount: 1 });

    // the retry: same job payload; only the failed listings are sent again
    await worker.runJob(
      stockPushJob,
      {
        marks: [
          { variantId: v["KAOS-M"], warehouseId, score: "1" },
          { variantId: p["PROMO-1"], warehouseId, score: "1" },
        ],
      },
      tenantId,
    );
    expect(await state("KAOS-M")).toMatchObject({ state: "synced", failCount: 0 });
    expect(await state("PROMO-1")).toMatchObject({ state: "failed" });
    expect((await state("PROMO-1")).lastError).toContain("reserved stock");
    expect(mock.shopeeShops.get(shopId)!.items!.find((i) => i.item_id === 702)!.stock).toBe(9);
  });

  it("pushes after mapping changes, rules, and on request; never doubles one warehouse in a listing", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    const { storeId, shopId } = await connectShopee(
      c,
      tenantId,
      [
        {
          item_id: 801,
          item_name: "Kaos",
          item_sku: "KAOS",
          item_status: "NORMAL",
          update_time: 1_700_000_000,
          price: 1,
          stockByLocation: { IDA: 2, IDB: 3 },
        },
      ],
      // multi-warehouse shop: two locations, both mapped to the business's only warehouse
      [
        { warehouse_id: 1, warehouse_name: "Jakarta Barat", location_id: "IDA" },
        { warehouse_id: 2, warehouse_name: "Tangerang", location_id: "IDB" },
      ],
    );
    const [listing] = (await c.get(`/v1/listings?storeId=${storeId}`)).body.items;
    expect(listing.mapping).toBeNull(); // item SKU KAOS is a product SKU, not a variant SKU
    await c.post("/v1/inventory/adjustments", {
      lines: [
        { variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 10 },
        { variantId: v["KAOS-L"], warehouseId, mode: "set", quantity: 4 },
      ],
      reason: "correction",
    });
    await goLive(c, storeId);
    await push(tenantId);
    const calls = () =>
      shopeeUpdates()
        .filter((x) => x.query.shop_id === shopId)
        .map((x) => bodyOf<ShopeeBody>(x));
    expect(calls()).toHaveLength(0);

    // mapping the listing pushes it: the physical stock is shown once, on one location
    await c.put(`/v1/listings/${listing.id}/mapping`, { variantId: v["KAOS-M"] });
    await push(tenantId);
    const stock = calls().at(-1)!.stock_list[0]!.seller_stock;
    expect(stock.map((s) => s.location_id).sort()).toEqual(["IDA", "IDB"]);
    expect(stock.map((s) => s.stock).sort((a, b) => a - b)).toEqual([0, 10]);

    // remapping to another variant forgets what was pushed and sends the new variant's stock
    await c.put(`/v1/listings/${listing.id}/mapping`, { variantId: v["KAOS-L"] });
    await push(tenantId);
    expect(
      calls()
        .at(-1)!
        .stock_list[0]!.seller_stock.map((s) => s.stock)
        .sort((a, b) => a - b),
    ).toEqual([0, 4]);

    // a store-wide rule: half, after a buffer of 1; then a rule for the variant wins
    const half = await c.post("/v1/stock-allocation-rules", { storeId, mode: "percent", value: 50, buffer: 1 });
    expect(half.status).toBe(201);
    await push(tenantId);
    expect(
      Math.max(
        ...calls()
          .at(-1)!
          .stock_list[0]!.seller_stock.map((s) => s.stock),
      ),
    ).toBe(1); // (4 - 1) * 50%
    const dup = await c.post("/v1/stock-allocation-rules", { storeId, mode: "all" });
    expect(dup.status).toBe(409);
    const fixed = await c.post("/v1/stock-allocation-rules", {
      storeId,
      variantId: v["KAOS-L"],
      mode: "fixed",
      value: 3,
    });
    await push(tenantId);
    expect(
      Math.max(
        ...calls()
          .at(-1)!
          .stock_list[0]!.seller_stock.map((s) => s.stock),
      ),
    ).toBe(3);
    const listed = (await c.get(`/v1/stock-allocation-rules?storeId=${storeId}`)).body.items as {
      id: string;
      variant: { sku: string } | null;
    }[];
    // a rule for one variant names it; a store-wide rule has none
    expect(listed.map((r) => [r.id, r.variant?.sku ?? null])).toEqual(
      expect.arrayContaining([
        [half.body.id, null],
        [fixed.body.id, "KAOS-L"],
      ]),
    );
    expect(listed).toHaveLength(2);
    expect(fixed.body.variant).toMatchObject({ sku: "KAOS-L" });
    const etag = (await c.get(`/v1/stock-allocation-rules/${fixed.body.id}`)).headers.etag as string;
    expect(
      (await c.patch(`/v1/stock-allocation-rules/${fixed.body.id}`, { value: 2 }).set("If-Match", etag)).status,
    ).toBe(200);
    expect(
      (await c.patch(`/v1/stock-allocation-rules/${fixed.body.id}`, { value: 1 }).set("If-Match", etag)).status,
    ).toBe(409);
    await push(tenantId);
    expect(
      Math.max(
        ...calls()
          .at(-1)!
          .stock_list[0]!.seller_stock.map((s) => s.stock),
      ),
    ).toBe(2);
    expect((await c.delete(`/v1/stock-allocation-rules/${fixed.body.id}`)).status).toBe(204);
    expect((await c.delete(`/v1/stock-allocation-rules/${half.body.id}`)).status).toBe(204);
    await push(tenantId);
    expect(
      Math.max(
        ...calls()
          .at(-1)!
          .stock_list[0]!.seller_stock.map((s) => s.stock),
      ),
    ).toBe(4);

    // "Dorong ulang stok": everything again, even values the marketplace has
    const n = calls().length;
    expect((await c.post("/v1/inventory/resync", { storeId })).status).toBe(202);
    await push(tenantId);
    expect(calls()).toHaveLength(n + 1);

    // unmapping removes the push state of the listing
    await c.put(`/v1/listings/${listing.id}/mapping`, { variantId: null });
    await drain(tenantId);
    expect((await c.get("/v1/inventory?q=KAOS-L")).body.items[0].push).toEqual([]);

    // a read-only store cannot be pushed on request
    await c.patch(`/v1/stores/${storeId}`, { syncMode: "read_only" });
    expect((await c.post("/v1/inventory/resync", { storeId })).body.code).toBe("store.not_live");
  });

  it("waits for another pusher of the same variant instead of racing it", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M"]);
    const { storeId, shopId } = await connectShopee(c, tenantId, [
      {
        item_id: 901,
        item_name: "Kaos",
        item_sku: "KAOS-M",
        item_status: "NORMAL",
        update_time: 1_700_000_000,
        price: 1,
        stock: 1,
      },
    ]);
    await goLive(c, storeId);
    await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 5 }],
      reason: "correction",
    });
    await drain(tenantId);
    const dirty = worker.ctx.get<StockDirtySet>(STOCK_DIRTY);
    expect(await dirty.tryLock(tenantId, v["KAOS-M"]!, "other-job", 60_000)).toBe(true);
    await worker.flushStock(tenantId);
    expect(shopeeUpdates().filter((x) => x.query.shop_id === shopId)).toHaveLength(0);
    // the pair was marked again, so it is pushed once the other job is done
    await dirty.unlock(tenantId, v["KAOS-M"]!, "other-job");
    await worker.flushStock(tenantId);
    expect(shopeeUpdates().filter((x) => x.query.shop_id === shopId)).toHaveLength(1);
  });
});

describe("stock push to Tokopedia & Shop (Update Inventory 202309)", () => {
  it("sends every warehouse of a SKU in one call, caps at 99,999, and leaves FBT stock alone", async () => {
    const { c, tenantId, warehouseId } = await business();
    // a second physical warehouse, before connecting, so the two TikTok warehouses are mapped by hand
    const surabaya = newId();
    await withTenantTx(h.api, userCtx(tenantId), (tx) =>
      tx.execute(sql`INSERT INTO warehouse (id, tenant_id, code, name, address)
                     VALUES (${surabaya}, ${tenantId}, 'SBY', 'Gudang Surabaya', '{}')`),
    );
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L", "KAOS-FBT", "KAOS-MIX"]);
    const products: MockTiktokProduct[] = [
      {
        id: "1729592969712207100",
        title: "Kaos",
        status: "ACTIVATE",
        update_time: 1_700_000_000,
        skus: [
          {
            id: "1729592969712207101",
            seller_sku: "KAOS-M",
            price: 50_000,
            attrs: {},
            inventory: { "7000000000000000001": 5, "7000000000000000002": 3 },
          },
          {
            id: "1729592969712207102",
            seller_sku: "KAOS-L",
            price: 50_000,
            attrs: {},
            inventory: { "7000000000000000001": 1 },
          },
        ],
      },
      {
        id: "1729592969712207200",
        title: "Kaos FBT",
        status: "ACTIVATE",
        update_time: 1_700_000_000,
        skus: [
          {
            id: "1729592969712207201",
            seller_sku: "KAOS-FBT",
            price: 50_000,
            attrs: {},
            inventory: { "8000000000000000001": 7 },
          },
        ],
      },
      {
        id: "1729592969712207300",
        title: "Kaos campur",
        status: "ACTIVATE",
        update_time: 1_700_000_000,
        skus: [
          {
            id: "1729592969712207301",
            seller_sku: "KAOS-MIX",
            price: 50_000,
            attrs: {},
            inventory: { "7000000000000000001": 1, "8000000000000000001": 2 },
          },
        ],
      },
    ];
    const sellerId = mock.addTiktokSeller({
      openId: "7010000000000000555",
      name: "Toko Tokopedia",
      shops: [
        {
          id: "7495000000000000555",
          name: "Toko Tokopedia",
          region: "ID",
          cipher: "ROW_stock",
          warehouses: [
            { id: "7000000000000000001", name: "Warehouse Jakarta", type: "SALES_WAREHOUSE", is_default: true },
            { id: "7000000000000000002", name: "Warehouse Surabaya", type: "SALES_WAREHOUSE", is_default: false },
          ],
          fbt: [{ fbt_warehouse_id: "8000000000000000001", name: "FBT Cikarang", subscribed: true }],
          products,
        },
      ],
    });
    const started = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
    await c.post("/v1/store-authorizations/callback", {
      channel: "tiktokshop",
      state: new URL(started.body.authorizeUrl).searchParams.get("state"),
      code: mock.tiktokCode(sellerId),
    });
    await drain(tenantId);
    const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0].storeId;
    const cws = (await c.get(`/v1/stores/${storeId}/channel-warehouses`)).body.items as {
      id: string;
      externalWarehouseId: string;
    }[];
    const cwOf = (ext: string) => cws.find((w) => w.externalWarehouseId === ext)!.id;
    await c.put(`/v1/stores/${storeId}/channel-warehouses/${cwOf("7000000000000000001")}`, { warehouseId });
    await c.put(`/v1/stores/${storeId}/channel-warehouses/${cwOf("7000000000000000002")}`, { warehouseId: surabaya });
    await goLive(c, storeId);

    await c.post("/v1/inventory/adjustments", {
      lines: [
        { variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 20 },
        { variantId: v["KAOS-M"], warehouseId: surabaya, mode: "set", quantity: 150_000 },
        { variantId: v["KAOS-L"], warehouseId, mode: "set", quantity: 0 },
        { variantId: v["KAOS-FBT"], warehouseId, mode: "set", quantity: 4 },
        { variantId: v["KAOS-MIX"], warehouseId, mode: "set", quantity: 6 },
      ],
      reason: "correction",
    });
    expect((await push(tenantId)).errors).toEqual([]);

    const updates = mock.calls
      .filter((x) => x.method === "POST" && x.path.endsWith("/inventory/update") && x.query.shop_cipher === "ROW_stock")
      .map((x) => ({ product: x.path.split("/")[4], body: JSON.parse(x.body) }));
    // KAOS-FBT is marketplace-managed: never sent
    expect(updates.map((u) => u.product).sort()).toEqual(["1729592969712207100", "1729592969712207300"]);
    const kaos = updates.find((u) => u.product === "1729592969712207100")!.body;
    expect(kaos.skus).toEqual([
      {
        id: "1729592969712207101",
        inventory: [
          { warehouse_id: "7000000000000000001", quantity: 20 },
          { warehouse_id: "7000000000000000002", quantity: 99_999 },
        ],
      },
      { id: "1729592969712207102", inventory: [{ warehouse_id: "7000000000000000001", quantity: 0 }] },
    ]);
    const shopProducts = products;
    expect(shopProducts[0]!.skus[0]!.inventory).toEqual({ "7000000000000000001": 20, "7000000000000000002": 99_999 });

    // a SKU stocked in a seller and an FBT warehouse cannot be updated without the FBT one: refused
    const mixed = (await c.get("/v1/inventory?q=KAOS-MIX")).body.items[0].push[0];
    expect(mixed).toMatchObject({ state: "failed", channelName: "Tokopedia & Shop" });
    expect(mixed.lastError).toContain("Multiple warehouses");
    const fbt = (await c.get("/v1/inventory?q=KAOS-FBT")).body.items[0].push[0];
    expect(fbt.state).toBe("pending");
  });
});
