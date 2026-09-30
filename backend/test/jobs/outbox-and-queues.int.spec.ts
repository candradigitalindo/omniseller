import { newId } from "@omniseller/shared";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { withTenantTx } from "../../src/db/tenant-tx";
import { defineEvent, defineJob } from "../../src/jobs/define";
import { jobKey } from "../../src/jobs/job-id";
import { QueueRegistry } from "../../src/jobs/queues";
import { JobRegistry } from "../../src/jobs/registry";
import { StockDirtySet } from "../../src/jobs/stock-dirty";
import { Outbox } from "../../src/outbox/outbox";
import { relayOnce } from "../../src/scheduler/outbox-relay";
import { flushStockDirty } from "../../src/scheduler/stock-flush";
import { createTenant, type TenantFixture } from "../setup/factories";
import { testHandles } from "../setup/handles";

const h = testHandles();

const priceChanged = defineEvent({
  type: "listing.price_push_requested",
  aggregate: "listing",
  schema: z.object({ listingId: z.string() }),
});

const acceptRequested = defineEvent({
  type: "order.accept_requested",
  aggregate: "order",
  schema: z.object({ orderId: z.string() }),
});

// per occurrence: the same listing may need several pushes
const pricePush = defineJob({
  queue: "mp.outbound",
  name: "listing.price_push",
  schema: z.object({ listingId: z.string() }),
  triggeredBy: [priceChanged],
  jobId: (p, meta) => jobKey("listing.price_push", p.listingId, meta.eventId ?? "direct"),
  handler: async () => {},
});

// a second consumer of the same event gets its own row and id
const priceNotify = defineJob({
  queue: "notify",
  name: "notify.price_changed",
  schema: z.object({ listingId: z.string() }),
  triggeredBy: [priceChanged],
  jobId: (p, meta) => jobKey("notify.price_changed", p.listingId, meta.eventId ?? "direct"),
  handler: async () => {},
});

// once per entity
const accept = defineJob({
  queue: "mp.outbound",
  name: "order.accept",
  schema: z.object({ orderId: z.string() }),
  triggeredBy: [acceptRequested],
  jobId: (p) => jobKey("order.accept", p.orderId),
  handler: async () => {},
});

describe("outbox and relay (invariant I4, ADR-024)", () => {
  let t: TenantFixture;
  let queues: QueueRegistry;
  const outbox = new Outbox(new JobRegistry([pricePush, priceNotify, accept]));

  beforeAll(async () => {
    t = await createTenant(h.api);
    queues = new QueueRegistry(h.redis, h.infra.keyPrefix);
    // drain anything other tests left behind so counts below are exact
    while ((await relayOnce(h.system, queues)) > 0) {}
  });

  afterAll(async () => {
    await queues.close();
  });

  const pending = async () =>
    Number(
      (
        await h.system.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM outbox_event WHERE published_at IS NULL`,
        )
      ).rows[0]!.n,
    );

  it("writes nothing when the business transaction rolls back", async () => {
    await withTenantTx(h.api, t.ctx, async (tx) => {
      await outbox.enqueue(tx, t.ctx, priceChanged, { listingId: newId() }, newId());
      throw new Error("business rule failed");
    }).catch(() => {});
    expect(await pending()).toBe(0);
  });

  it("writes one row per consumer and validates the payload", async () => {
    const ids = await withTenantTx(h.api, t.ctx, (tx) =>
      outbox.enqueue(tx, t.ctx, priceChanged, { listingId: newId() }, newId()),
    );
    expect(ids).toHaveLength(2);
    await expect(
      withTenantTx(h.api, t.ctx, (tx) => outbox.enqueue(tx, t.ctx, priceChanged, { listingId: 42 } as never, newId())),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it("relays to BullMQ with deterministic ids and marks rows published", async () => {
    const listingId = newId();
    await withTenantTx(h.api, t.ctx, (tx) => outbox.enqueue(tx, t.ctx, priceChanged, { listingId }, listingId));
    while ((await relayOnce(h.system, queues)) > 0) {}
    expect(await pending()).toBe(0);
    const jobs = await queues.get("mp.outbound").getJobs(["waiting"]);
    const mine = jobs.filter((j) => (j.data as { listingId?: string }).listingId === listingId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toMatch(new RegExp(`^listing\\.price_push\\|${listingId}\\|[0-9A-Z]{26}$`));
    expect(mine[0]!.data).toMatchObject({ listingId, tenantId: t.tenantId });
  });

  it("does not duplicate a job when the relay repeats a row, but keeps later occurrences", async () => {
    const listingId = newId();
    await withTenantTx(h.api, t.ctx, (tx) => outbox.enqueue(tx, t.ctx, priceChanged, { listingId }, listingId));
    while ((await relayOnce(h.system, queues)) > 0) {}
    // simulate a crash between queue.add and the commit that marks the row published
    await h.system.db.execute(
      sql`UPDATE outbox_event SET published_at = NULL WHERE payload->>'listingId' = ${listingId}`,
    );
    while ((await relayOnce(h.system, queues)) > 0) {}
    // a second, genuine price change for the same listing
    await withTenantTx(h.api, t.ctx, (tx) => outbox.enqueue(tx, t.ctx, priceChanged, { listingId }, listingId));
    while ((await relayOnce(h.system, queues)) > 0) {}
    const jobs = (await queues.get("mp.outbound").getJobs(["waiting"])).filter(
      (j) => (j.data as { listingId?: string }).listingId === listingId,
    );
    expect(jobs).toHaveLength(2);
  });

  it("collapses repeated requests for a once-per-entity job", async () => {
    const orderId = newId();
    for (let i = 0; i < 3; i++) {
      await withTenantTx(h.api, t.ctx, (tx) => outbox.enqueue(tx, t.ctx, acceptRequested, { orderId }, orderId));
    }
    while ((await relayOnce(h.system, queues)) > 0) {}
    const jobs = (await queues.get("mp.outbound").getJobs(["waiting"])).filter(
      (j) => (j.data as { orderId?: string }).orderId === orderId,
    );
    expect(jobs.map((j) => j.id)).toEqual([`order.accept|${orderId}`]);
  });

  it("wakes listeners through NOTIFY outbox", async () => {
    const client = await h.raw("system");
    await client.query("LISTEN outbox");
    const got = new Promise<string>((resolve) => client.on("notification", (n) => resolve(n.channel)));
    await withTenantTx(h.api, t.ctx, (tx) => outbox.enqueue(tx, t.ctx, priceChanged, { listingId: newId() }, newId()));
    expect(await got).toBe("outbox");
  });
});

describe("stock push debounce (backend doc 9.4, ADR-006)", () => {
  let queues: QueueRegistry;
  let dirty: StockDirtySet;

  beforeAll(() => {
    queues = new QueueRegistry(h.redis, h.infra.keyPrefix);
    dirty = new StockDirtySet(h.redis, `${h.infra.keyPrefix}:stock:dirty`);
  });

  afterAll(async () => {
    await queues.close();
  });

  it("only releases keys after they have been quiet, and re-marking restarts the wait", async () => {
    const [tenant, variant, warehouse] = [newId(), newId(), newId()];
    await dirty.mark(tenant, variant, warehouse, 1_000);
    expect(await dirty.ready(4_000, 5000)).toHaveLength(0);
    await dirty.mark(tenant, variant, warehouse, 4_500);
    expect(await dirty.ready(9_000, 5000)).toHaveLength(0);
    const ready = await dirty.ready(9_600, 5000);
    expect(ready).toEqual([{ tenantId: tenant, variantId: variant, warehouseId: warehouse, score: "4500" }]);
    expect(await dirty.ack(ready[0]!)).toBe(true);
  });

  it("keeps a key that changed between read and ack", async () => {
    const [tenant, variant, warehouse] = [newId(), newId(), newId()];
    await dirty.mark(tenant, variant, warehouse, 10_000);
    const [k] = await dirty.ready(20_000, 5000);
    await dirty.mark(tenant, variant, warehouse, 19_000); // a new change lands before the ack
    expect(await dirty.ack(k!)).toBe(false);
    const again = await dirty.ready(30_000, 5000);
    expect(again.map((x) => x.score)).toContain("19000");
  });

  it("enqueues a new push for every quiet period, even while an earlier push job is still retained", async () => {
    const [tenant, variant, warehouse] = [newId(), newId(), newId()];
    const queue = queues.get("stock.push");

    await dirty.mark(tenant, variant, warehouse, 100_000);
    expect(await flushStockDirty(dirty, queues, 110_000)).toBeGreaterThanOrEqual(1);
    // The first push job is still held by BullMQ (here waiting; after it finishes it is kept for an
    // hour by removeOnComplete.age). Either way its id blocks an identical id.

    await dirty.mark(tenant, variant, warehouse, 200_000);
    await flushStockDirty(dirty, queues, 210_000);
    const all = await queue.getJobs(["waiting", "completed", "active"]);
    const mine = all.filter((j) => (j.data as { variantId: string }).variantId === variant);
    expect(mine.map((j) => j.id).sort()).toEqual(
      [jobKey("stock.push", variant, warehouse, "100000"), jobKey("stock.push", variant, warehouse, "200000")].sort(),
    );
  });

  it("the business-key-only id from the original design would have dropped the second push", async () => {
    // Regression guard for backend doc 9.2 v1.0: `stock.push:<variant>:<warehouse>`.
    const queue = new Queue("stock.push", { connection: h.redis, prefix: `${h.infra.keyPrefix}_legacy` });
    const legacyId = `stock.push|${newId()}|${newId()}`;
    await queue.add("stock.push", { n: 1 }, { jobId: legacyId });
    await queue.add("stock.push", { n: 2 }, { jobId: legacyId });
    expect(await queue.getJobCounts("waiting")).toMatchObject({ waiting: 1 });
    await queue.obliterate({ force: true });
    await queue.close();
  });
});

describe("pre-tenant lookups (webhook routing and login)", () => {
  it("resolves a marketplace shop to its tenant without a tenant context", async () => {
    const t = await createTenant(h.api);
    const shopId = `shop-${newId()}`;
    const storeId = await withTenantTx(h.api, t.ctx, async (tx) => {
      const id = newId();
      await tx.execute(
        sql`INSERT INTO store (id, tenant_id, channel, external_shop_id, name) VALUES (${id}, ${t.tenantId}, 'tiktokshop', ${shopId}, 'Toko TikTok')`,
      );
      return id;
    });
    const api = await h.raw("api");
    const r = await api.query("SELECT * FROM resolve_store('tiktokshop', $1)", [shopId]);
    expect(r.rows).toEqual([
      { tenant_id: t.tenantId, store_id: storeId, status: "connecting", sync_mode: "read_only" },
    ]);
    expect((await api.query("SELECT * FROM resolve_store('shopee', $1)", [shopId])).rowCount).toBe(0);
  });

  it("lists login candidates across tenants for one email, case-insensitively", async () => {
    const email = `rina.${newId().slice(-6).toLowerCase()}@contoh.id`;
    const tenants = [await createTenant(h.api), await createTenant(h.api)];
    for (const t of tenants) {
      await withTenantTx(h.api, t.ctx, (tx) =>
        tx.execute(sql`INSERT INTO "user" (id, tenant_id, email, password_hash, name, status)
                       VALUES (${newId()}, ${t.tenantId}, ${email}, 'argon2id$fake', 'Rina', 'active')`),
      );
    }
    const api = await h.raw("api");
    const r = await api.query<{ tenant_id: string }>("SELECT tenant_id FROM auth_login_candidates($1)", [
      email.toUpperCase(),
    ]);
    expect(r.rows.map((x) => x.tenant_id).sort()).toEqual(tenants.map((t) => t.tenantId).sort());
  });
});
