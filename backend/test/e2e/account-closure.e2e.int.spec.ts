import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { newIdAt } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { purgeReminderJob } from "../../src/modules/closure/closure.jobs";
import { tenantPurgeJob } from "../../src/modules/retention/retention.jobs";
import { TenantPurgeService } from "../../src/modules/retention/tenant-purge.service";
import { scanAccountClosures } from "../../src/scheduler/closure-scan";
import { scanLegalReminders } from "../../src/scheduler/legal-scan";
import { runRetention } from "../../src/scheduler/retention-run";
import { type Client, client, PASSWORD, signup, startApi, startWorker, tokenFrom, uniqueEmail } from "../setup/app";
import { testFilesDir } from "../setup/files-dir";
import { testHandles } from "../setup/handles";
import { MockMarketplace, type MockShopeeItem } from "../setup/mock-marketplace";
import { MockXendit } from "../setup/mock-xendit";

/**
 * Account closure and the deletion of a business (PRD 12.1, backend doc 8.36), and retention.run (9.5): who
 * manages billing closes the account; its stores are disconnected, its plan moves to Starter, open
 * invitations go, and everyone else is signed out; for 30 days it can still be read, exported, and
 * reopened; then the purge deletes every row and file of it but its invoices and subscriptions.
 */
const h = testHandles();
let mock: MockMarketplace;
let xendit: MockXendit;
let api: INestApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let queues: QueueRegistry;
const registry = new JobRegistry(JOB_DEFINITIONS);
let shopSeq = 930000;

beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  // its own invoice ids: the test files share one database, and `invoice.external_invoice_id` is unique
  xendit = new MockXendit({ idPrefix: "mockclosure" });
  await xendit.start();
  api = await startApi(h.infra, { marketplace: mock, xendit });
  worker = await startWorker(h.infra, h.system, { marketplace: mock, xendit });
  queues = new QueueRegistry(h.redis, h.infra.keyPrefix);
});

afterAll(async () => {
  await queues?.close();
  await worker?.close();
  await api?.close();
  await mock?.close();
  await xendit?.close();
});

async function drain(tenantId: string): Promise<void> {
  for (let i = 0; i < 20; i++) if ((await worker.runOutbox(tenantId)).length === 0) return;
}

async function business() {
  const { c, email, me } = await signup(api);
  await drain(me.tenant.id);
  return { c, email, me, tenantId: me.tenant.id };
}

async function invite(owner: Client, tenantId: string, role: string) {
  const roles = (await owner.get("/v1/roles")).body.items as { id: string; name: string }[];
  const email = uniqueEmail(role.toLowerCase());
  const sent = await owner.post("/v1/invitations", { email, roleId: roles.find((r) => r.name === role)!.id });
  expect(sent.status).toBe(201);
  await drain(tenantId);
  return { email, token: tokenFrom(worker.email.lastTo(email)!.text) };
}

async function addMember(owner: Client, tenantId: string, role: string) {
  const { email, token } = await invite(owner, tenantId, role);
  const member = client(api);
  const accepted = await member.post("/v1/auth/invitations/accept", { token, name: role, password: PASSWORD });
  expect(accepted.status).toBe(201);
  return { member, email };
}

const kaos: MockShopeeItem = {
  item_id: 931,
  item_name: "Kaos",
  item_sku: "KAOS",
  item_status: "NORMAL",
  update_time: 1_700_000_000,
  tiers: [{ name: "Ukuran", options: ["M"] }],
  models: [{ model_id: 9311, model_sku: "KAOS-M", tier_index: [0], price: 50_000, stock: 3 }],
};

async function connectShopee(c: Client, tenantId: string) {
  const shopId = String(++shopSeq);
  mock.addShopeeShop({
    shopId,
    name: `Toko ${shopId}`,
    region: "ID",
    warehouses: "not_whitelisted",
    items: [kaos],
    orders: [],
  });
  const started = await c.post("/v1/store-authorizations", { channel: "shopee" });
  await c.post("/v1/store-authorizations/callback", {
    channel: "shopee",
    state: new URL(started.body.authorizeUrl).searchParams.get("state"),
    code: mock.shopeeCode({ shopId }),
    shopId,
  });
  await drain(tenantId);
  return shopId;
}

/** Some of everything a business keeps: a product with stock, a manual order, a tag, and an export ZIP. */
async function fill(c: Client, tenantId: string) {
  const warehouseId = (await c.get("/v1/warehouses")).body.items[0].id as string;
  const variant = (
    await c.post("/v1/products", {
      sku: "TAS",
      name: "Tas Anyam",
      variants: [{ sku: "TAS-1", basePrice: 120_000, costPrice: 60_000, weightG: 400 }],
    })
  ).body.variants[0].id as string;
  expect(
    (
      await c.post("/v1/inventory/adjustments", {
        lines: [{ variantId: variant, warehouseId, mode: "set", quantity: 10 }],
        reason: "correction",
      })
    ).status,
  ).toBe(200);
  const channel = (await c.post("/v1/stores/manual", { name: "WhatsApp" })).body.id as string;
  const placed = await c.post("/v1/orders/manual", {
    storeId: channel,
    buyer: { name: "Sari", phone: "081300000001" },
    shippingAddress: { line1: "Jl. Kenanga 3", city: "Bandung", province: "Jawa Barat" },
    items: [{ variantId: variant, qty: 2 }],
    paymentMethod: "cash",
  });
  expect(placed.status).toBe(201);
  expect((await c.post("/v1/tags", { name: "Prioritas", color: "#E34948" })).status).toBe(201);
  expect((await c.post("/v1/exports", {})).status).toBe(202);
  await drain(tenantId);
}

const purgeTables = async () =>
  (await h.system.db.execute<{ table_name: string }>(sql`SELECT table_name FROM tenant_purge_order()`)).rows.map(
    (r) => r.table_name,
  );

/** Rows of the business in every table the purge walks, and in the tables it keeps. */
async function rowsOf(tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of [...(await purgeTables()), "invoice", "subscription"]) {
    const r = await h.system.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE tenant_id = ${tenantId}`,
    );
    const n = Number(r.rows[0]!.n);
    if (n > 0) counts[t] = n;
  }
  return counts;
}

describe("closing an account (PRD 12.1, backend doc 8.36)", () => {
  it("disconnects the stores, moves to Starter, signs everyone else out, and keeps it readable until reopened", async () => {
    const { c, email, me, tenantId } = await business();
    await connectShopee(c, tenantId);
    // a manual sales channel has no marketplace to stop
    expect((await c.post("/v1/stores/manual", { name: "WhatsApp" })).status).toBe(201);
    // an NIB being made for five and a half months: its deadline reminder is due (UI L47)
    const since = new Date(Date.now() - 167 * 86_400_000).toISOString().slice(0, 10);
    expect((await c.patch("/v1/business-profile", { nibInProcessSince: since })).status).toBe(200);
    const { member, email: memberEmail } = await addMember(c, tenantId, "Gudang");
    const open = await invite(c, tenantId, "CS");
    expect((await member.get("/v1/me")).status).toBe(200);

    // the caller's own password and the business's name, typed again
    const wrongPassword = await c.post("/v1/account-closure", { businessName: "Toko Uji Coba", password: "salah" });
    expect([wrongPassword.status, wrongPassword.body.errors?.[0]?.path]).toEqual([422, "password"]);
    const wrongName = await c.post("/v1/account-closure", { businessName: "Toko Lain", password: PASSWORD });
    expect([wrongName.status, wrongName.body.errors?.[0]?.path]).toEqual([422, "businessName"]);
    // members never may
    expect(
      (await member.post("/v1/account-closure", { businessName: "toko uji coba", password: PASSWORD })).status,
    ).toBe(403);

    const before = Date.now();
    const closed = await c.post("/v1/account-closure", { businessName: "  toko  uji coba ", password: PASSWORD });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      status: "closing",
      closedBy: { id: me.user.id, name: "Rina" },
      purgeAfterDays: 30,
      revokeLinks: [{ channel: "shopee", url: expect.stringMatching(/^https?:\/\//) }],
    });
    const purgeAfter = Date.parse(closed.body.purgeAfter);
    expect(purgeAfter - Date.parse(closed.body.closingAt)).toBe(30 * 86_400_000);
    expect(Date.parse(closed.body.closingAt)).toBeGreaterThanOrEqual(before - 1000);
    // a closing account takes no writes: closing it again is one
    expect((await c.post("/v1/account-closure", { businessName: "Toko Uji Coba", password: PASSWORD })).body.code).toBe(
      "tenant.read_only",
    );
    await drain(tenantId);

    // the stores stop, the trial ends on Starter, the open invitation is gone
    const stores = (await c.get("/v1/stores")).body.items as { channel: string; status: string }[];
    expect(stores.filter((s) => s.channel === "shopee").map((s) => s.status)).toEqual(["disconnected"]);
    expect(stores.filter((s) => s.channel === "manual").map((s) => s.status)).toEqual(["active"]);
    // a closing business hears no more reminders
    await scanLegalReminders(h.system, queues, registry);
    expect(
      (await queues.get("notify").getJobs(["waiting", "delayed"])).filter(
        (j) => j.name === "business.legal_alert" && j.data.tenantId === tenantId,
      ),
    ).toEqual([]);
    expect((await c.get("/v1/me")).body).toMatchObject({ tenant: { status: "closing" }, plan: { code: "starter" } });
    const accept = await client(api).post("/v1/auth/invitations/accept", {
      token: open.token,
      name: "CS",
      password: PASSWORD,
    });
    expect(accept.body.code).toBe("invitation.invalid");

    // the member is out and cannot come back; the owner reads, exports, and signs out, but writes nothing
    expect((await member.get("/v1/me")).status).toBe(401);
    const memberLogin = await client(api).post("/v1/auth/login", { email: memberEmail, password: PASSWORD });
    expect([memberLogin.status, memberLogin.body.code]).toEqual([403, "tenant.closing"]);
    expect((await c.get("/v1/products")).status).toBe(200);
    const write = await c.post("/v1/tags", { name: "Baru", color: "#E34948" });
    expect([write.status, write.body.code]).toEqual([403, "tenant.read_only"]);
    expect((await c.post("/v1/exports", {})).status).toBe(202);

    // who manages billing hears of it, in the app and by email, and the log says who closed it
    const notes = (await c.get("/v1/notifications")).body.items as { title: string; body: string }[];
    expect(notes[0]).toMatchObject({
      title: "Akun bisnis ditutup",
      body: expect.stringContaining("ditutup oleh Rina"),
    });
    expect(worker.email.lastTo(email)?.subject).toContain("Akun bisnis ditutup");
    const log = (await c.get("/v1/audit-logs?limit=50")).body.items as {
      entityType: string;
      actor: { name: string };
    }[];
    expect(log.find((e) => e.entityType === "tenant")).toMatchObject({ actor: { name: "Rina" } });

    // the owner signs in again, and reopens
    const again = client(api);
    expect((await again.post("/v1/auth/login", { email, password: PASSWORD })).status).toBe(200);
    const reopened = await again.delete("/v1/account-closure");
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({
      status: "active",
      closingAt: null,
      purgeAfter: null,
      closedBy: null,
      revokeLinks: [],
    });
    expect((await again.delete("/v1/account-closure")).body.code).toBe("account.not_closing");
    expect((await client(api).post("/v1/auth/login", { email: memberEmail, password: PASSWORD })).status).toBe(200);
    expect((await again.post("/v1/tags", { name: "Baru", color: "#E34948" })).status).toBe(201);
    // the stores stay disconnected: the seller connects them again
    expect(
      ((await again.get("/v1/stores")).body.items as { channel: string; status: string }[]).find(
        (s) => s.channel === "shopee",
      )?.status,
    ).toBe("disconnected");
    await drain(tenantId);
    expect(worker.email.lastTo(email)?.subject).toContain("Akun bisnis dibuka kembali");
  });

  it("reminds once a week before the deletion, and not before", async () => {
    const { c, email, tenantId } = await business();
    expect((await c.post("/v1/account-closure", { businessName: "Toko Uji Coba", password: PASSWORD })).status).toBe(
      200,
    );
    await drain(tenantId);
    const queued = async () =>
      (await queues.get("notify").getJobs(["waiting", "delayed"])).filter(
        (j) => j.name === "account.purge_reminder" && j.data.tenantId === tenantId,
      );

    await h.system.db.execute(sql`UPDATE tenant SET purge_after = now() + interval '8 days' WHERE id = ${tenantId}`);
    await scanAccountClosures(h.system, queues, registry);
    expect(await queued()).toEqual([]);
    // too early even when the job runs anyway
    const early = (
      await h.system.db.execute<{ purge_after: string }>(sql`SELECT purge_after FROM tenant WHERE id = ${tenantId}`)
    ).rows[0]!.purge_after;
    await worker.runJob(purgeReminderJob, { purgeAfter: new Date(early).toISOString() }, tenantId);

    await h.system.db.execute(sql`UPDATE tenant SET purge_after = now() + interval '6 days' WHERE id = ${tenantId}`);
    await scanAccountClosures(h.system, queues, registry);
    await scanAccountClosures(h.system, queues, registry);
    const jobs = await queued();
    expect(jobs).toHaveLength(1);
    await worker.runJob(purgeReminderJob, jobs[0]!.data, tenantId);
    await worker.runJob(purgeReminderJob, jobs[0]!.data, tenantId);
    for (const j of jobs) await j.remove();
    await drain(tenantId);
    const notes = (await c.get("/v1/notifications")).body.items as { title: string }[];
    expect(notes.filter((n) => n.title === "Data bisnis segera dihapus")).toHaveLength(1);
    expect(worker.email.lastTo(email)?.subject).toContain("Data bisnis segera dihapus");
    // reminded: the scan asks no more
    await scanAccountClosures(h.system, queues, registry);
    expect(await queued()).toEqual([]);
  });

  it("withdraws a move up still waiting for payment", async () => {
    const { c, tenantId } = await business();
    // Starter at once, then Growth from when it is paid: an upgrade invoice waits
    expect((await c.post("/v1/billing/subscription", { planCode: "starter" })).status).toBe(200);
    expect((await c.post("/v1/billing/subscription", { planCode: "growth" })).status).toBe(200);
    await drain(tenantId);
    const waiting = (await c.get("/v1/billing/invoices")).body.items as { kind: string; status: string }[];
    expect(waiting.map((i) => [i.kind, i.status])).toEqual([["upgrade", "pending"]]);
    expect((await c.post("/v1/account-closure", { businessName: "Toko Uji Coba", password: PASSWORD })).status).toBe(
      200,
    );
    const after = (await c.get("/v1/billing/invoices")).body.items as { status: string }[];
    expect(after.map((i) => i.status)).toEqual(["void"]);
    expect((await c.get("/v1/me")).body.plan.code).toBe("starter");
  });

  it("deletes the business after its purge date, keeping its invoices and nobody else's data", async () => {
    const gone = await business();
    const other = await business();
    await fill(gone.c, gone.tenantId);
    await fill(other.c, other.tenantId);
    await addMember(gone.c, gone.tenantId, "Gudang");
    // Growth after the trial, still to pay: an invoice, a tax record that outlives the business
    expect((await gone.c.post("/v1/billing/subscription", { planCode: "growth" })).status).toBe(200);
    await drain(gone.tenantId);
    const files = join(testFilesDir(h.infra.keyPrefix), "t", gone.tenantId);
    expect(existsSync(files)).toBe(true);
    const otherBefore = await rowsOf(other.tenantId);
    const goneBefore = await rowsOf(gone.tenantId);
    expect(goneBefore).toMatchObject({
      product: 1,
      order: 1,
      audit_log: expect.any(Number),
      user: 2,
      subscription: 1,
      invoice: 1,
    });

    expect(
      (await gone.c.post("/v1/account-closure", { businessName: "Toko Uji Coba", password: PASSWORD })).status,
    ).toBe(200);
    await drain(gone.tenantId);
    // the waiting invoice was withdrawn, and the trial gave way to Starter at once
    const invoices = (await gone.c.get("/v1/billing/invoices")).body.items as { status: string }[];
    expect(invoices.map((i) => i.status)).toEqual(["void"]);
    const closedRows = await rowsOf(gone.tenantId);
    expect([closedRows.subscription, closedRows.invoice]).toEqual([2, 1]);

    // not before its date: the scan leaves it, and the purge functions refuse it
    expect(await worker.runJob(tenantPurgeJob, { slot: "early" }, gone.tenantId)).toBeUndefined();
    expect((await rowsOf(gone.tenantId)).product).toBe(1);

    await h.system.db.execute(
      sql`UPDATE tenant SET purge_after = now() - interval '1 minute' WHERE id = ${gone.tenantId}`,
    );
    const queued = async () =>
      (await queues.get("import").getJobs(["waiting", "delayed"])).filter(
        (j) => j.name === "tenant.purge" && [gone.tenantId, other.tenantId].includes(j.data.tenantId),
      );
    await scanAccountClosures(h.system, queues, registry);
    const jobs = await queued();
    expect(jobs.map((j) => j.data.tenantId)).toEqual([gone.tenantId]);
    for (const j of jobs) await j.remove();

    // an event still waiting in the outbox goes too
    const waiting = newIdAt(new Date());
    await h.system.db.execute(sql`
      INSERT INTO outbox_event (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, queue, job_name, job_id)
      VALUES (${waiting}, ${gone.tenantId}, 'test', ${waiting}, 'test.event', '{}', 'notify', 'test.job', ${waiting})`);
    // a run out of time stops early, and the purge never ends while a row is left
    expect(await worker.ctx.get(TenantPurgeService, { strict: false }).run(gone.tenantId, 0)).toBe("continued");
    // the stored files go first; one a late job stores meanwhile goes at the end
    expect(existsSync(files)).toBe(false);
    mkdirSync(join(files, "export"), { recursive: true });
    writeFileSync(join(files, "export", "late.zip"), "late");
    const asWorker = await h.raw("worker");
    try {
      expect((await asWorker.query("SELECT finish_tenant_purge($1) AS done", [gone.tenantId])).rows[0].done).toBe(
        false,
      );
    } finally {
      await asWorker.end();
    }
    expect((await h.system.db.execute(sql`SELECT 1 FROM outbox_event WHERE id = ${waiting}`)).rows).toEqual([]);

    await worker.runJob(tenantPurgeJob, { slot: "now" }, gone.tenantId);
    // every row went but the tax records; the files too; the other business kept all of its own
    expect(await rowsOf(gone.tenantId)).toEqual({ subscription: 2, invoice: 1 });
    expect(existsSync(files)).toBe(false);
    expect(await rowsOf(other.tenantId)).toEqual(otherBefore);
    const tenant = (
      await h.system.db.execute<{ status: string; name: string; slug: string; purged: boolean }>(
        sql`SELECT status, name, slug, purged_at IS NOT NULL AS purged FROM tenant WHERE id = ${gone.tenantId}`,
      )
    ).rows[0];
    expect(tenant).toEqual({
      status: "closed",
      name: "Bisnis dihapus",
      slug: `dihapus-${gone.tenantId.toLowerCase()}`,
      purged: true,
    });
    // nobody signs in any more, and the scan is done with it
    expect((await gone.c.get("/v1/me")).status).toBe(401);
    expect((await client(api).post("/v1/auth/login", { email: gone.email, password: PASSWORD })).status).toBe(401);
    await scanAccountClosures(h.system, queues, registry);
    expect(await queued()).toEqual([]);
    // the slug is free again
    const reused = await signup(api, { businessName: "Toko Uji Coba" });
    expect(reused.me.tenant.slug).toBeDefined();
  });
});

describe("retention.run (backend doc 9.5)", () => {
  it("deletes webhooks after 30 days and published outbox events after 7, nothing else", async () => {
    const { tenantId } = await business();
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    const inbox = async (id: string, received: Date) =>
      h.system.db.execute(sql`
        INSERT INTO webhook_inbox (id, source, event_id, tenant_id, received_at, signature_valid, headers, payload)
        VALUES (${id}, 'shopee', ${id}, ${tenantId}, ${received.toISOString()}::timestamptz, true, '{}', '{}')`);
    const outbox = async (id: string, published: Date | null) =>
      h.system.db.execute(sql`
        INSERT INTO outbox_event (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, queue, job_name, job_id, published_at)
        VALUES (${id}, ${tenantId}, 'test', ${id}, 'test.event', '{}', 'notify', 'test.job', ${id},
                ${published ? published.toISOString() : null}::timestamptz)`);
    const oldHook = newIdAt(daysAgo(31));
    const freshHook = newIdAt(daysAgo(29));
    const oldEvent = newIdAt(daysAgo(8));
    const waitingEvent = newIdAt(daysAgo(8));
    const freshEvent = newIdAt(daysAgo(6));
    await inbox(oldHook, daysAgo(31));
    await inbox(freshHook, daysAgo(29));
    await outbox(oldEvent, daysAgo(8));
    await outbox(waitingEvent, null);
    await outbox(freshEvent, daysAgo(6));

    const ran = await runRetention(h.system);
    expect(ran.webhooks).toBeGreaterThanOrEqual(1);
    expect(ran.events).toBeGreaterThanOrEqual(1);
    const left = async (table: string, ids: string[]) =>
      (
        await h.system.db.execute<{ id: string }>(
          sql`SELECT id FROM ${sql.identifier(table)} WHERE id IN (${sql.join(
            ids.map((i) => sql`${i}`),
            sql`, `,
          )}) ORDER BY id`,
        )
      ).rows.map((r) => r.id);
    expect(await left("webhook_inbox", [oldHook, freshHook])).toEqual([freshHook]);
    expect(await left("outbox_event", [oldEvent, waitingEvent, freshEvent])).toEqual([waitingEvent, freshEvent].sort());
    await h.system.db.execute(sql`DELETE FROM outbox_event WHERE id IN (${waitingEvent}, ${freshEvent})`);
  });
});
