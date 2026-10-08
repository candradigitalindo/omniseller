import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDate } from "../../src/common/time-zone";
import { withTenantTx } from "../../src/db/tenant-tx";
import { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import {
  billingInvoiceCallbackJob,
  billingInvoiceCreateJob,
  billingRenewJob,
  billingTrialStartJob,
} from "../../src/modules/billing/billing.jobs";
import { InvoicePdfService } from "../../src/modules/billing/invoice-pdf.service";
import { ExportRenderService } from "../../src/modules/exports/export-render.service";
import { scanBillingRenewals } from "../../src/scheduler/billing-scan";
import {
  type Client,
  client,
  type MeBody,
  PASSWORD,
  signup,
  startApi,
  startWebhook,
  startWorker,
  tokenFrom,
  uniqueEmail,
  WEB_URL,
} from "../setup/app";
import { createStore, userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace } from "../setup/mock-marketplace";
import { MockXendit, XENDIT_TEST_TOKEN } from "../setup/mock-xendit";

/**
 * Subscriptions and billing end to end (PRD 15.1; backend doc 8.32; UI L45): the trial every business
 * starts on, choosing and paying plans through Xendit's page and callback, moving up at once with credit
 * for what is left, moving down at the end of the paid month, periods paid early, renewals, reminders,
 * lapsing to Starter, withdrawn invoices closed at Xendit, the plan's quotas, and the monthly order meter.
 * Time moves by shifting the business's subscription and invoice dates in the database; the renewal job
 * decides by those dates alone.
 */
const h = testHandles();
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let xendit: MockXendit;
let marketplace: MockMarketplace;
let queues: QueueRegistry;
const registry = new JobRegistry(JOB_DEFINITIONS);
let shopSeq = 880000;
let whSeq = 0;
let slotSeq = 0;

const DAY = 86_400_000;
const days = (n: number) => n * DAY;
const thisMonth = () => localDate("Asia/Jakarta", new Date()).slice(0, 7);

beforeAll(async () => {
  xendit = new MockXendit();
  await xendit.start();
  marketplace = new MockMarketplace();
  await marketplace.start();
  api = await startApi(h.infra, { marketplace, xendit });
  hooks = await startWebhook(h.infra, { xendit: true });
  worker = await startWorker(h.infra, h.system, { marketplace, xendit });
  queues = new QueueRegistry(h.redis, h.infra.keyPrefix);
});

afterAll(async () => {
  await queues?.close();
  await worker?.close();
  await hooks?.close();
  await api?.close();
  await marketplace?.close();
  await xendit?.close();
});

interface InvoiceBody {
  id: string;
  number: string;
  kind: "renewal" | "upgrade";
  planCode: string;
  status: string;
  amount: number;
  creditAmount: number;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  paidAt: string | null;
  paidAmount: number | null;
  paymentMethod: string | null;
  paymentChannel: string | null;
  invoiceUrl: string | null;
  invoiceExpiresAt: string | null;
  error: string | null;
}
interface PlanBody {
  code: string;
  name: string;
  priceMonthly: number;
  limits: Record<string, number | null>;
}
interface StateBody {
  plan: PlanBody;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string | null;
  nextPlan: PlanBody | null;
  lapsesAt: string | null;
  paymentsAvailable: boolean;
  usage: {
    orders: { value: number; limit: number | null; period: string };
    stores: { value: number; limit: number | null };
    warehouses: { value: number; limit: number | null };
    users: { value: number; limit: number | null };
  };
  plans: PlanBody[];
  pendingInvoice: InvoiceBody | null;
  prepaidInvoice: InvoiceBody | null;
  invoices: InvoiceBody[];
}
interface Notice {
  kind: string;
  severity: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

async function drain(tenantId: string): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < 20; i++) {
    const round = await worker.runOutbox(tenantId);
    if (round.length === 0) break;
    ran.push(...round);
  }
  return ran;
}

/** A business past its signup jobs: the trial row exists. */
async function business() {
  const { c, me, email } = await signup(api);
  await drain(me.tenant.id);
  return { c, me, email, tenantId: me.tenant.id };
}

const state = async (c: Client): Promise<StateBody> => {
  const res = await c.get("/v1/billing/subscription");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const choose = (c: Client, planCode: string) => c.post("/v1/billing/subscription", { planCode });
const invoiceOf = async (c: Client, id: string): Promise<InvoiceBody> =>
  (await c.get(`/v1/billing/invoices/${id}`)).body;
const notices = async (c: Client, reason: string): Promise<Notice[]> =>
  ((await c.get("/v1/notifications")).body.items as Notice[]).filter(
    (n) => n.kind === "billing.reminder" && n.data.reason === reason,
  );

/** The clock moves `ms` ahead: every subscription and invoice date of the business comes that much closer. */
async function travel(tenantId: string, ms: number): Promise<void> {
  const secs = Math.round(ms / 1000);
  await h.system.db.execute(sql`
    UPDATE subscription SET current_period_start = current_period_start - make_interval(secs => ${secs}),
                            current_period_end = current_period_end - make_interval(secs => ${secs})
     WHERE tenant_id = ${tenantId}`);
  await h.system.db.execute(sql`
    UPDATE invoice SET period_start = period_start - make_interval(secs => ${secs}),
                       period_end = period_end - make_interval(secs => ${secs}),
                       due_at = due_at - make_interval(secs => ${secs}),
                       invoice_expires_at = invoice_expires_at - make_interval(secs => ${secs}),
                       paid_at = paid_at - make_interval(secs => ${secs})
     WHERE tenant_id = ${tenantId}`);
}

/** Moves the clock to `beforeEnd` ms before the live subscription's period end. */
async function travelToEnd(c: Client, tenantId: string, beforeEnd: number): Promise<StateBody> {
  const s = await state(c);
  await travel(tenantId, Date.parse(s.currentPeriodEnd!) - Date.now() - beforeEnd);
  return state(c);
}

const renew = (tenantId: string) => worker.runJob(billingRenewJob, { slot: `t${++slotSeq}` }, tenantId);

/** Xendit's callback as it would arrive at the webhook process. */
function postCallback(body: Record<string, unknown>, token = XENDIT_TEST_TOKEN, webhookId = `wh-${++whSeq}`) {
  return request(hooks.getHttpServer())
    .post("/webhooks/xendit")
    .set("content-type", "application/json")
    .set("x-callback-token", token)
    .set("webhook-id", webhookId)
    .send(JSON.stringify(body));
}

async function callbackJobs(tenantId: string) {
  const jobs = await queues.get("billing").getJobs(["waiting", "delayed", "prioritized", "paused"]);
  return jobs.filter((j) => j.name === "billing.invoice_callback" && j.data.tenantId === tenantId);
}

/** The webhook process takes the callback and enqueues; the worker's job applies it. */
async function pay(tenantId: string, invoiceId: string, status: "PAID" | "EXPIRED" | "SETTLED" = "PAID") {
  const body = xendit.callbackFor(invoiceId, status);
  const res = await postCallback(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  for (const j of await callbackJobs(tenantId)) {
    await worker.runJob(billingInvoiceCallbackJob, j.data, tenantId);
    await j.remove();
  }
  return body;
}

/** A business that kept Growth after its trial and paid for it: its first paid month has begun. */
async function paidGrowth() {
  const b = await business();
  const inv = (await choose(b.c, "growth")).body.pendingInvoice as InvoiceBody;
  await drain(b.tenantId);
  await pay(b.tenantId, inv.id);
  await travelToEnd(b.c, b.tenantId, -60_000);
  await renew(b.tenantId);
  expect(await state(b.c)).toMatchObject({ status: "active", plan: { code: "growth" }, prepaidInvoice: null });
  return { ...b, firstInvoice: inv };
}

/** A PDF answer as bytes (supertest buffers only the types it knows). */
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (d: Buffer) => chunks.push(d));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

async function billToOf(invoiceId: string): Promise<unknown> {
  const r = await h.system.db.execute<{ bill_to: unknown }>(sql`SELECT bill_to FROM invoice WHERE id = ${invoiceId}`);
  return r.rows[0]!.bill_to;
}

async function planInForce(tenantId: string): Promise<string> {
  const r = await h.system.db.execute<{ code: string }>(
    sql`SELECT p.code FROM tenant t JOIN plan p ON p.id = t.plan_id WHERE t.id = ${tenantId}`,
  );
  return r.rows[0]!.code;
}

async function subscriptionRows(tenantId: string) {
  const r = await h.system.db.execute<{ code: string; status: string }>(
    sql`SELECT p.code, s.status FROM subscription s JOIN plan p ON p.id = s.plan_id
         WHERE s.tenant_id = ${tenantId} ORDER BY s.id`,
  );
  return r.rows.map((x) => `${x.code}:${x.status}`);
}

async function roleId(c: Client, name: string): Promise<string> {
  const res = await c.get("/v1/roles");
  return (res.body.items as { id: string; name: string }[]).find((r) => r.name === name)!.id;
}

async function addMember(owner: Client, tenantId: string, role: string) {
  const email = uniqueEmail("staf");
  const invite = await owner.post("/v1/invitations", { email, roleId: await roleId(owner, role) });
  expect(invite.status).toBe(201);
  await drain(tenantId);
  const token = tokenFrom(worker.email.lastTo(email)!.text);
  const member = client(api);
  const accepted = await member.post("/v1/auth/invitations/accept", { token, name: "Budi", password: PASSWORD });
  expect(accepted.status).toBe(201);
  return { member, me: accepted.body as MeBody };
}

describe("subscriptions and billing (PRD 15.1, backend doc 8.32, UI L45)", () => {
  it("starts every business on a 14-day trial of Growth and shows plans, quotas, and usage", async () => {
    const { c, me } = await signup(api);
    const tenantId = me.tenant.id;
    // before the worker wrote the trial row, the api still knows the trial from the plan and the signup date
    const before = await state(c);
    expect(before).toMatchObject({
      status: "trialing",
      plan: { code: "growth", name: "Growth", priceMonthly: 899_000 },
      nextPlan: null,
      paymentsAvailable: true,
      pendingInvoice: null,
      prepaidInvoice: null,
      invoices: [],
      usage: {
        orders: { value: 0, limit: 10_000, period: thisMonth() },
        stores: { value: 0, limit: 10 },
        warehouses: { value: 1, limit: 2 },
        users: { value: 1, limit: 10 },
      },
    });
    expect(Date.parse(before.lapsesAt!) - Date.parse(before.currentPeriodStart)).toBe(days(14));
    expect(before.currentPeriodEnd).toBe(before.lapsesAt);
    expect(before.plans.map((p) => [p.code, p.priceMonthly])).toEqual([
      ["starter", 0],
      ["growth", 899_000],
      ["business", 2_499_000],
    ]);
    expect(before.plans[0]!.limits).toEqual({ stores: 2, warehouses: 1, ordersPerMonth: 1000, users: 2 });
    expect(before.plans[2]!.limits).toEqual({ stores: null, warehouses: null, ordersPerMonth: 100_000, users: null });
    expect(await planInForce(tenantId)).toBe("growth");

    expect(await drain(tenantId)).toContain("billing.trial_start");
    const after = await state(c);
    expect(after).toMatchObject({
      status: "trialing",
      currentPeriodStart: before.currentPeriodStart,
      currentPeriodEnd: before.currentPeriodEnd,
      lapsesAt: before.lapsesAt,
    });
    // the job is idempotent: a second run (the hourly scan, a BullMQ retry) adds no row
    await worker.runJob(billingTrialStartJob, { slot: "again" }, tenantId);
    expect(await subscriptionRows(tenantId)).toEqual(["growth:trialing"]);
    // the trial is in the audit log under its plan's name
    const log = (await c.get("/v1/audit-logs?entity_type=subscription")).body.items as {
      change: string;
      label: string | null;
    }[];
    expect(log).toEqual([expect.objectContaining({ change: "created", label: "Growth" })]);
    // billing is the Owner's: an Admin has no settings:billing
    const admin = await addMember(c, tenantId, "Admin");
    expect((await admin.member.get("/v1/billing/subscription")).status).toBe(403);
    expect((await admin.member.post("/v1/billing/subscription", { planCode: "starter" })).status).toBe(403);
    expect((await admin.member.get(`/v1/billing/invoices/${newId()}/pdf`)).status).toBe(403);
  });

  it("keeps Growth after the trial: paid early through Xendit, the paid month starts when the trial ends", async () => {
    const { c, email, tenantId } = await business();
    const trial = await state(c);
    const chosen = (await choose(c, "growth")).body as StateBody;
    expect(chosen.status).toBe("trialing");
    const inv = chosen.pendingInvoice!;
    expect(inv).toMatchObject({
      kind: "renewal",
      planCode: "growth",
      status: "pending",
      amount: 899_000,
      creditAmount: 0,
      periodStart: trial.currentPeriodEnd,
      dueAt: trial.currentPeriodEnd,
      invoiceUrl: null,
    });
    expect(inv.number).toMatch(/^INV-\d{4}-0001$/);
    // choosing it again answers with the same invoice
    expect((await choose(c, "growth")).body.pendingInvoice.id).toBe(inv.id);

    // the worker asks Xendit for the payment page, open until the grace days after the trial are over
    expect(await drain(tenantId)).toContain("billing.invoice_create");
    const atXendit = xendit.byExternalId(inv.id)!;
    expect(atXendit).toMatchObject({ amount: 899_000, payerEmail: email, status: "PENDING" });
    expect(atXendit.description).toContain("Growth");
    expect(atXendit.body).toMatchObject({
      currency: "IDR",
      locale: "id",
      success_redirect_url: `${WEB_URL}/langganan?bayar=sukses`,
      failure_redirect_url: `${WEB_URL}/langganan?bayar=gagal`,
      items: [{ quantity: 1, price: 899_000 }],
      metadata: { tenant_id: tenantId, invoice_id: inv.id, invoice_number: inv.number },
    });
    const graceEnd = Date.parse(trial.currentPeriodEnd!) + days(7);
    expect(Math.abs((atXendit.body.invoice_duration as number) - (graceEnd - Date.now()) / 1000)).toBeLessThan(120);
    expect((await invoiceOf(c, inv.id)).invoiceUrl).toBe(`${xendit.url}/web/invoices/${atXendit.id}`);

    // the callback: a wrong token, an invoice that is not ours, then the real one delivered twice
    expect((await postCallback(xendit.callbackFor(inv.id, "PAID"), "another-token")).status).toBe(401);
    const stranger = { ...xendit.callbackFor(inv.id, "PAID"), external_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" };
    expect((await postCallback(stranger)).status).toBe(200);
    expect(await callbackJobs(tenantId)).toEqual([]);
    const body = xendit.callbackFor(inv.id, "PAID");
    expect((await postCallback(body, XENDIT_TEST_TOKEN, "wh-same")).status).toBe(200);
    expect((await postCallback(body, XENDIT_TEST_TOKEN, "wh-same")).status).toBe(200);
    const jobs = await callbackJobs(tenantId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(`billing.invoice_callback|${inv.id}|wh-same`);
    await worker.runJob(billingInvoiceCallbackJob, jobs[0]!.data, tenantId);
    await jobs[0]!.remove();

    // paid early: the trial goes on, and the month after it is paid
    const paid = await state(c);
    expect(paid).toMatchObject({
      status: "trialing",
      plan: { code: "growth" },
      pendingInvoice: null,
      prepaidInvoice: {
        id: inv.id,
        status: "paid",
        paidAt: body.paid_at,
        paidAmount: 899_000,
        paymentMethod: "BANK_TRANSFER",
        paymentChannel: "BCA",
      },
      currentPeriodEnd: trial.currentPeriodEnd,
    });
    const told = await notices(c, "paid");
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ severity: "info", title: `Pembayaran ${inv.number} diterima` });
    expect(told[0]!.body).toMatch(/^Paket Growth berlanjut /);
    expect(await drain(tenantId)).toContain("notification.email");
    expect(worker.email.lastTo(email)!.subject).toContain("Pembayaran");
    // the dashboard has nothing to press for: the month after the trial is paid
    expect((await c.get("/v1/dashboard")).body.tasks.some((t: { kind: string }) => t.kind === "billing_due")).toBe(
      false,
    );
    // the same callback again, or SETTLED after PAID, changes nothing
    await pay(tenantId, inv.id, "SETTLED");
    expect((await invoiceOf(c, inv.id)).paidAt).toBe(body.paid_at);
    expect(await notices(c, "paid")).toHaveLength(1);
    // the next period is paid: the plan cannot change until it begins
    const locked = await choose(c, "business");
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe("billing.next_period_paid");

    // the trial ends: the paid month begins on the same subscription
    await travelToEnd(c, tenantId, -60_000);
    await renew(tenantId);
    const month = await state(c);
    const shifted = await invoiceOf(c, inv.id);
    expect(month).toMatchObject({
      status: "active",
      plan: { code: "growth" },
      prepaidInvoice: null,
      lapsesAt: null,
      currentPeriodStart: shifted.periodStart,
      currentPeriodEnd: shifted.periodEnd,
    });
    expect(await subscriptionRows(tenantId)).toEqual(["growth:active"]);
    // the invoice's life is in the audit log under its number
    const log = (await c.get(`/v1/audit-logs?entity_type=invoice&entity_id=${inv.id}`)).body.items as {
      change: string;
      label: string | null;
      changes: { field: string; before: unknown; after: unknown }[];
    }[];
    expect(log.map((e) => [e.change, e.label])).toEqual([
      ["updated", inv.number],
      ["created", inv.number],
    ]);
    expect(log[0]!.changes).toContainEqual({ field: "status", before: "pending", after: "paid" });
  });

  it("moves up from a paid month at once, less what is left of it", async () => {
    const { c, tenantId } = await paidGrowth();
    // ten days into the paid month
    await travel(tenantId, days(10));
    const s0 = await state(c);
    const up = (await choose(c, "business")).body as StateBody;
    const inv = up.pendingInvoice!;
    const total = Date.parse(s0.currentPeriodEnd!) - Date.parse(s0.currentPeriodStart);
    const left = Date.parse(s0.currentPeriodEnd!) - Date.now();
    expect(inv).toMatchObject({ kind: "upgrade", planCode: "business", status: "pending" });
    expect(Math.abs(inv.creditAmount - Math.floor((899_000 * left) / total))).toBeLessThan(100);
    expect(inv.creditAmount).toBeGreaterThan(500_000);
    expect(inv.amount).toBe(2_499_000 - inv.creditAmount);
    expect(Date.parse(inv.dueAt) - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    // Growth goes on until Business is paid
    expect(up).toMatchObject({ status: "active", plan: { code: "growth" } });
    // choosing it again answers with the same invoice
    expect((await choose(c, "business")).body.pendingInvoice.id).toBe(inv.id);

    await drain(tenantId);
    const atXendit = xendit.byExternalId(inv.id)!;
    expect(atXendit.amount).toBe(inv.amount);
    expect(atXendit.description).toContain("dikurangi sisa paket sebelumnya");
    const paidAt = Date.now();
    await pay(tenantId, inv.id);
    const s1 = await state(c);
    expect(s1).toMatchObject({ status: "active", plan: { code: "business" }, pendingInvoice: null });
    // the month starts when it was paid
    expect(Math.abs(Date.parse(s1.currentPeriodStart) - paidAt)).toBeLessThan(60_000);
    expect(s1.invoices.find((i) => i.id === inv.id)).toMatchObject({
      status: "paid",
      creditAmount: inv.creditAmount,
      periodStart: s1.currentPeriodStart,
      periodEnd: s1.currentPeriodEnd,
    });
    expect(await subscriptionRows(tenantId)).toEqual(["growth:cancelled", "business:active"]);
    // the paying invoice belongs to the subscription it started
    const owner = await h.system.db.execute<{ status: string }>(
      sql`SELECT s.status FROM invoice i JOIN subscription s ON s.id = i.subscription_id WHERE i.id = ${inv.id}`,
    );
    expect(owner.rows[0]!.status).toBe("active");
    expect(await planInForce(tenantId)).toBe("business");
    expect((await notices(c, "paid"))[0]!.body).toMatch(/^Paket Business aktif sampai /);
  });

  it("prints an invoice as PDF billed to the business and its NPWP, and keeps who a paid one was billed to", async () => {
    const { c, me, tenantId } = await business();
    const address = {
      line1: "Jl. Melati No. 5",
      district: "Coblong",
      city: "Kota Bandung",
      province: "Jawa Barat",
      postalCode: "40132",
    };
    const saved = await c.patch("/v1/business-profile", {
      name: "Toko Rina Jaya",
      address,
      npwp: "12.345.678.9-012.000",
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const inv = (await choose(c, "growth")).body.pendingInvoice as InvoiceBody;
    await drain(tenantId);
    const payUrl = (await invoiceOf(c, inv.id)).invoiceUrl;
    expect(payUrl).toBeTruthy();

    const res = await binary(c.get(`/v1/billing/invoices/${inv.id}/pdf`));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${inv.number}.pdf"`);
    expect(res.headers["cache-control"]).toBe("no-store"); // the api's own rule for every answer
    const pdf = await PDFDocument.load(res.body as Buffer);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe(`Tagihan ${inv.number}`);

    // what the PDF says, as the api assembles it
    const pdfs = api.get(InvoicePdfService);
    const ctx = userCtx(tenantId, me.user.id);
    const waiting = await pdfs.document(ctx, inv.id);
    expect(waiting).toMatchObject({
      number: inv.number,
      statusLabel: "Menunggu pembayaran",
      issuer: { name: "PT Uji Niaga Digital", lines: ["NPWP 01.234.567.8-901.000"] },
      billTo: {
        name: "Toko Rina Jaya",
        lines: ["Jl. Melati No. 5", "Coblong, Kota Bandung", "Jawa Barat 40132", "NPWP 12.345.678.9-012.000"],
      },
      totals: [{ label: "Total", value: "Rp 899.000", strong: true }],
    });
    expect(waiting.lines[0]!.description).toBe("Langganan OmniSeller paket Growth");
    expect(waiting.notes[0]).toBe(`Bayar di ${payUrl} atau lewat menu Langganan & Tagihan di OmniSeller.`);
    // while it waits, it follows the profile
    expect(await billToOf(inv.id)).toBeNull();
    expect((await c.patch("/v1/business-profile", { npwp: "3171234567890123" })).status).toBe(200);
    expect((await pdfs.document(ctx, inv.id)).billTo.lines.at(-1)).toBe("NPWP 3171234567890123");

    // paid: the copy taken with the payment is what it prints from then on
    await pay(tenantId, inv.id);
    expect(await billToOf(inv.id)).toEqual({ name: "Toko Rina Jaya", address, npwp: "3171234567890123" });
    expect(
      (await c.patch("/v1/business-profile", { name: "PT Rina Jaya Abadi", address: {}, npwp: null })).status,
    ).toBe(200);
    const paid = await pdfs.document(ctx, inv.id);
    expect(paid).toMatchObject({
      statusLabel: "Lunas",
      billTo: {
        name: "Toko Rina Jaya",
        lines: ["Jl. Melati No. 5", "Coblong, Kota Bandung", "Jawa Barat 40132", "NPWP 3171234567890123"],
      },
      totals: [
        { label: "Total", value: "Rp 899.000", strong: true },
        { label: "Dibayar", value: "Rp 899.000", strong: false },
      ],
    });
    expect(paid.facts.slice(2).map((f) => f.label)).toEqual(["Tanggal bayar", "Metode pembayaran"]);
    expect(paid.facts.at(-1)!.value).toBe("Transfer bank BCA");
    expect((await binary(c.get(`/v1/billing/invoices/${inv.id}/pdf`))).status).toBe(200);
    // the copy stays out of the invoice's audit entries: the profile it came from is audited itself
    const audit = await h.system.db.execute<{ action: string; after: Record<string, unknown> }>(
      sql`SELECT action, after FROM audit_log WHERE tenant_id = ${tenantId} AND entity_type = 'invoice'
           AND entity_id = ${inv.id} ORDER BY id`,
    );
    expect(audit.rows.map((r) => [r.action, r.after.status])).toEqual([
      ["insert", "pending"],
      ["update", "paid"],
    ]);
    expect(audit.rows.filter((r) => "bill_to" in r.after)).toEqual([]);
    // another business's invoice, or none at all
    const other = await business();
    const refused = await other.c.get(`/v1/billing/invoices/${inv.id}/pdf`);
    expect([refused.status, refused.body.code]).toEqual([404, "invoice.not_found"]);
    expect((await c.get(`/v1/billing/invoices/${newId()}/pdf`)).status).toBe(404);
  });

  it("moves down at the end of the paid month: the cheaper plan is billed a week ahead and takes over", async () => {
    const { c, tenantId } = await paidGrowth();
    const up = (await choose(c, "business")).body.pendingInvoice as InvoiceBody;
    await drain(tenantId);
    await pay(tenantId, up.id);
    expect((await state(c)).plan.code).toBe("business");

    // Business to Growth: Business runs on until its month ends
    const down = (await choose(c, "growth")).body as StateBody;
    expect(down).toMatchObject({ plan: { code: "business" }, nextPlan: { code: "growth" }, pendingInvoice: null });
    expect((await choose(c, "growth")).body.code).toBe("billing.same_plan");

    // five days before the end: Growth's invoice for the next month
    await travelToEnd(c, tenantId, days(5));
    await renew(tenantId);
    const s1 = await state(c);
    expect(s1.pendingInvoice).toMatchObject({
      kind: "renewal",
      planCode: "growth",
      amount: 899_000,
      periodStart: s1.currentPeriodEnd,
    });
    expect((await notices(c, "invoice_due"))[0]!.title).toContain("untuk Growth jatuh tempo");
    await drain(tenantId);
    const growthAtXendit = xendit.byExternalId(s1.pendingInvoice!.id)!;

    // staying on Business after all: Growth's invoice is withdrawn and its Xendit page closed
    const stay = (await choose(c, "business")).body as StateBody;
    expect(stay.nextPlan).toBeNull();
    expect(stay.pendingInvoice).toMatchObject({ kind: "renewal", planCode: "business", amount: 2_499_000 });
    expect(await drain(tenantId)).toEqual(expect.arrayContaining(["billing.invoice_expire", "billing.invoice_create"]));
    expect(xendit.expired.has(growthAtXendit.id)).toBe(true);
    expect((await invoiceOf(c, s1.pendingInvoice!.id)).status).toBe("void");

    // Growth once more, paid early this time: it takes over when Business's month ends
    const again = (await choose(c, "growth")).body as StateBody;
    expect(again.pendingInvoice).toMatchObject({ kind: "renewal", planCode: "growth" });
    await drain(tenantId);
    await pay(tenantId, again.pendingInvoice!.id);
    expect(await state(c)).toMatchObject({
      status: "active",
      plan: { code: "business" },
      nextPlan: { code: "growth" },
      prepaidInvoice: { planCode: "growth" },
    });
    await travelToEnd(c, tenantId, -60_000);
    await renew(tenantId);
    expect(await state(c)).toMatchObject({
      status: "active",
      plan: { code: "growth" },
      nextPlan: null,
      prepaidInvoice: null,
      pendingInvoice: null,
    });
    expect(await subscriptionRows(tenantId)).toEqual(["growth:cancelled", "business:cancelled", "growth:active"]);
    expect(await planInForce(tenantId)).toBe("growth");
    const changed = await notices(c, "plan_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.title).toBe("Bisnis kini memakai paket Growth");
  });

  it("bills the renewal a week ahead, asks Xendit again after a refusal, falls past due, and lapses to Starter", async () => {
    const { c, tenantId } = await paidGrowth();
    // five days before the end, and Xendit refuses the renewal invoice at first
    await travelToEnd(c, tenantId, days(5));
    xendit.failNext(400, { error_code: "API_VALIDATION_ERROR", message: "payer_email is invalid" });
    await renew(tenantId);
    await drain(tenantId);
    const refused = (await state(c)).invoices[0]!;
    expect(refused).toMatchObject({
      kind: "renewal",
      status: "failed",
      error: "Xendit menjawab 400 (API_VALIDATION_ERROR).",
    });
    expect(refused.number).toMatch(/-0002$/);
    expect(await notices(c, "invoice_due")).toHaveLength(1);
    // the hourly job leaves it alone for six hours, never numbering another one
    await renew(tenantId);
    expect((await state(c)).invoices.map((i) => i.status)).toEqual(["failed", "paid"]);
    await h.system.db.execute(
      sql`UPDATE invoice SET status_changed_at = now() - interval '7 hours' WHERE id = ${refused.id}`,
    );
    await renew(tenantId);
    expect(await drain(tenantId)).toContain("billing.invoice_create");
    const due = await state(c);
    expect(due.pendingInvoice).toMatchObject({
      id: refused.id,
      number: refused.number,
      status: "pending",
      error: null,
    });
    expect(due.pendingInvoice!.invoiceUrl).toContain(xendit.url);
    expect((await c.get("/v1/dashboard")).body.tasks).toContainEqual(
      expect.objectContaining({
        kind: "billing_due",
        severity: "warning",
        title: expect.stringContaining(refused.number),
      }),
    );
    // a renewal invoice is not withdrawn by hand: choosing another plan does that
    expect((await c.post(`/v1/billing/invoices/${refused.id}/void`)).body.code).toBe("invoice.renewal");

    // the period ends unpaid: past due, with seven days of grace
    await travelToEnd(c, tenantId, -3600_000);
    await renew(tenantId);
    const late = await state(c);
    expect(late.status).toBe("past_due");
    expect(Date.parse(late.lapsesAt!) - Date.parse(late.currentPeriodEnd!)).toBe(days(7));
    expect(late.pendingInvoice!.id).toBe(refused.id);
    const told = await notices(c, "past_due");
    expect(told).toHaveLength(1);
    expect(told[0]!.severity).toBe("critical");
    expect((await c.get("/v1/dashboard")).body.tasks).toContainEqual(
      expect.objectContaining({ kind: "billing_due", severity: "critical", title: expect.stringContaining("Starter") }),
    );
    expect(await planInForce(tenantId)).toBe("growth");

    // paid during the grace days: the period it pays for began already, so it applies at once
    await pay(tenantId, refused.id);
    expect(await state(c)).toMatchObject({
      status: "active",
      plan: { code: "growth" },
      lapsesAt: null,
      pendingInvoice: null,
      currentPeriodStart: late.currentPeriodEnd,
      currentPeriodEnd: late.pendingInvoice!.periodEnd,
    });

    // a month later nobody pays: past due, then Starter once the grace days are over
    await travelToEnd(c, tenantId, -days(8));
    await renew(tenantId);
    const lapsed = await state(c);
    expect(lapsed).toMatchObject({
      status: "active",
      plan: { code: "starter", priceMonthly: 0 },
      currentPeriodEnd: null,
      lapsesAt: null,
      pendingInvoice: null,
    });
    expect(await planInForce(tenantId)).toBe("starter");
    const ended = await notices(c, "expired");
    expect(ended).toHaveLength(1);
    expect(ended[0]!.title).toBe("Paket Growth berakhir karena tagihan tidak dibayar");
    expect(await subscriptionRows(tenantId)).toEqual(["growth:expired", "starter:active"]);
    // newest first: the renewal nobody paid was withdrawn when the plan ended
    expect(lapsed.invoices.map((i) => i.status)).toEqual(["void", "paid", "paid"]);
  });

  it("steps down to Starter at the end of a paid month, or at once from a trial", async () => {
    const { c, tenantId } = await paidGrowth();
    await travelToEnd(c, tenantId, days(3));
    await renew(tenantId);
    expect((await state(c)).pendingInvoice).not.toBeNull();

    // what was paid keeps running; the renewal invoice is withdrawn
    const down = (await choose(c, "starter")).body as StateBody;
    expect(down).toMatchObject({
      status: "active",
      plan: { code: "growth" },
      nextPlan: { code: "starter" },
      pendingInvoice: null,
    });
    expect(down.invoices.map((i) => i.status)).toEqual(["void", "paid"]);
    expect((await choose(c, "starter")).body.code).toBe("billing.same_plan");
    // the dashboard has nothing to press for
    expect((await c.get("/v1/dashboard")).body.tasks.some((t: { kind: string }) => t.kind === "billing_due")).toBe(
      false,
    );
    // staying after all brings the renewal invoice back, since the period ends within a week
    const stay = (await choose(c, "growth")).body as StateBody;
    expect(stay).toMatchObject({ nextPlan: null, pendingInvoice: { kind: "renewal", planCode: "growth" } });
    expect((await choose(c, "starter")).body.nextPlan.code).toBe("starter");

    // the period ends: Starter, as asked
    await travelToEnd(c, tenantId, -60_000);
    await renew(tenantId);
    expect(await state(c)).toMatchObject({
      status: "active",
      plan: { code: "starter" },
      currentPeriodEnd: null,
      nextPlan: null,
    });
    expect(await planInForce(tenantId)).toBe("starter");
    expect(await notices(c, "downgraded")).toHaveLength(1);
    expect((await choose(c, "starter")).status).toBe(409);
    expect(await subscriptionRows(tenantId)).toEqual(["growth:cancelled", "starter:active"]);

    // from a trial, Starter at once
    const other = await business();
    const now = (await choose(other.c, "starter")).body as StateBody;
    expect(now).toMatchObject({ status: "active", plan: { code: "starter" }, currentPeriodEnd: null, lapsesAt: null });
    expect(await planInForce(other.tenantId)).toBe("starter");
  });

  it("warns three days before a trial ends, lapses to Starter, gives a kept trial its grace days, and needs Xendit", async () => {
    const { c, email, tenantId } = await business();
    await travelToEnd(c, tenantId, days(2));
    await renew(tenantId);
    const told = await notices(c, "trial_ending");
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toMatch(/^Uji coba Growth berakhir /);
    expect((await c.get("/v1/dashboard")).body.tasks).toContainEqual(
      expect.objectContaining({
        kind: "billing_due",
        severity: "warning",
        title: expect.stringContaining("dalam 2 hari"),
      }),
    );
    await renew(tenantId);
    expect(await notices(c, "trial_ending")).toHaveLength(1);

    // the hourly scan picks businesses whose period ends within a week
    const picked = await scanBillingRenewals(h.system, queues, registry);
    expect(picked.renew).toBeGreaterThanOrEqual(1);
    const queued = await queues.get("billing").getJobs(["waiting", "delayed"]);
    expect(queued.some((j) => j.name === "billing.renew" && j.data.tenantId === tenantId)).toBe(true);
    for (const j of queued) await j.remove();

    // the trial ends: Starter and its quotas
    await travelToEnd(c, tenantId, -60_000);
    await renew(tenantId);
    expect(await state(c)).toMatchObject({
      status: "active",
      plan: { code: "starter" },
      currentPeriodEnd: null,
      usage: { stores: { limit: 2 }, warehouses: { limit: 1 }, users: { limit: 2 } },
    });
    expect(await planInForce(tenantId)).toBe("starter");
    const ended = await notices(c, "trial_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]!.severity).toBe("warning");
    expect(await drain(tenantId)).toContain("notification.email");
    expect(worker.email.lastTo(email)!.subject).toContain("Uji coba");

    // a trial whose next month was chosen but not paid keeps Growth through the grace days
    const kept = await business();
    const keep = (await choose(kept.c, "growth")).body.pendingInvoice as InvoiceBody;
    await drain(kept.tenantId);
    const trialEnd = (await travelToEnd(kept.c, kept.tenantId, -60_000)).currentPeriodEnd!;
    await renew(kept.tenantId);
    const grace = await state(kept.c);
    expect(grace).toMatchObject({ status: "past_due", plan: { code: "growth" }, pendingInvoice: { id: keep.id } });
    expect(Date.parse(grace.lapsesAt!) - Date.parse(trialEnd)).toBe(days(7));
    await travelToEnd(kept.c, kept.tenantId, -days(7) - 60_000);
    await renew(kept.tenantId);
    expect(await state(kept.c)).toMatchObject({ plan: { code: "starter" }, pendingInvoice: null });
    expect(await subscriptionRows(kept.tenantId)).toEqual(["growth:expired", "starter:active"]);

    // an environment without Xendit shows the plans but cannot sell one
    const off = await startApi(h.infra);
    try {
      const c2 = client(off);
      expect((await c2.post("/v1/auth/login", { email, password: PASSWORD })).status).toBe(200);
      const there = await c2.get("/v1/billing/subscription");
      expect(there.body).toMatchObject({ paymentsAvailable: false, plan: { code: "starter" } });
      expect(there.body.plans).toHaveLength(3);
      const refused = await c2.post("/v1/billing/subscription", { planCode: "growth" });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe("billing.payments_unavailable");
    } finally {
      await off.close();
    }
    // an unknown plan
    expect((await choose(c, "platinum")).status).toBe(422);
  });

  it("holds the plan's quotas: warehouses, marketplace stores, and seats", async () => {
    const { c, tenantId } = await business();
    const warehouseId = (await c.get("/v1/warehouses")).body.items[0].id as string;
    // Growth: two warehouses; a deleted one frees its place
    const second = await c.post("/v1/warehouses", { code: "DUA", name: "Gudang Dua" });
    expect(second.status).toBe(201);
    const third = await c.post("/v1/warehouses", { code: "TIGA", name: "Gudang Tiga" });
    expect(third.status).toBe(422);
    expect(third.body).toMatchObject({ code: "billing.limit_reached", metric: "warehouses", limit: 2, plan: "Growth" });
    expect(third.body.detail).toBe(
      "Paket Growth membatasi 2 gudang. Naik paket di Langganan & Tagihan untuk menambah.",
    );
    expect((await c.delete(`/v1/warehouses/${second.body.id}`)).status).toBe(204);
    expect((await c.post("/v1/warehouses", { code: "TIGA", name: "Gudang Tiga" })).status).toBe(201);

    // Starter from now: two marketplace stores and two seats
    expect((await choose(c, "starter")).status).toBe(200);
    // a manual sales channel and a disconnected store are not connected marketplace stores
    expect((await c.post("/v1/stores/manual", { name: "WhatsApp" })).status).toBe(201);
    const [first] = await withTenantTx(h.worker, userCtx(tenantId), async (tx) => [
      await createStore(tx, tenantId, { externalShopId: String(++shopSeq), warehouseId }),
    ]);
    const gone = await withTenantTx(h.worker, userCtx(tenantId), (tx) =>
      createStore(tx, tenantId, { externalShopId: String(++shopSeq), warehouseId }),
    );
    await h.system.db.execute(
      sql`UPDATE store SET status = 'disconnected', status_reason = 'disconnected_by_user', status_changed_at = now() WHERE id = ${gone}`,
    );
    expect((await c.post("/v1/store-authorizations", { channel: "shopee" })).status).toBe(201);
    await withTenantTx(h.worker, userCtx(tenantId), (tx) =>
      createStore(tx, tenantId, { externalShopId: String(++shopSeq), warehouseId }),
    );
    const start = await c.post("/v1/store-authorizations", { channel: "shopee" });
    expect(start.status).toBe(422);
    expect(start.body).toMatchObject({ code: "billing.limit_reached", metric: "stores", limit: 2, plan: "Starter" });
    // reconnecting a store never counts
    expect((await c.post("/v1/store-authorizations", { channel: "shopee", storeId: first })).status).toBe(201);
    // what is over the quota stays; it is shown against the new plan
    expect((await state(c)).usage).toMatchObject({
      stores: { value: 2, limit: 2 },
      warehouses: { value: 2, limit: 1 },
      users: { value: 1, limit: 2 },
    });

    // an open invitation holds a seat until it is revoked
    const viewer = await roleId(c, "Viewer");
    const invited = await c.post("/v1/invitations", { email: uniqueEmail("a"), roleId: viewer });
    expect(invited.status).toBe(201);
    const refused = await c.post("/v1/invitations", { email: uniqueEmail("b"), roleId: viewer });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "billing.limit_reached", metric: "users", limit: 2, plan: "Starter" });
    expect((await state(c)).usage.users).toEqual({ value: 2, limit: 2 });
    expect((await c.delete(`/v1/invitations/${invited.body.id}`)).status).toBe(204);
    expect((await c.post("/v1/invitations", { email: uniqueEmail("c"), roleId: viewer })).status).toBe(201);
  });

  it("meters orders per month and warns once at 80% and once at 100%", async () => {
    const { c, tenantId } = await business();
    const warehouseId = (await c.get("/v1/warehouses")).body.items[0].id as string;
    const channel = await c.post("/v1/stores/manual", { name: "Toko Offline" });
    expect(channel.status).toBe(201);
    const product = await c.post("/v1/products", {
      sku: "KAOS",
      name: "Kaos",
      variants: [{ sku: "KAOS-1", basePrice: 50_000, costPrice: 20_000, weightG: 200 }],
    });
    expect(product.status).toBe(201);
    const variantId = product.body.variants[0].id as string;
    const stocked = await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId, warehouseId, mode: "set", quantity: 100 }],
      reason: "correction",
    });
    expect(stocked.status).toBe(200);
    const order = async () => {
      const r = await c.post("/v1/orders/manual", {
        storeId: channel.body.id,
        buyer: { name: "Sari" },
        items: [{ variantId, qty: 1 }],
        paymentMethod: "cash",
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    };
    await order();
    expect((await state(c)).usage.orders).toEqual({ value: 1, limit: 10_000, period: thisMonth() });

    // 7,999 orders later
    await h.system.db.execute(
      sql`UPDATE usage_counter SET value = 7999 WHERE tenant_id = ${tenantId} AND metric = 'orders'`,
    );
    await order();
    expect((await state(c)).usage.orders.value).toBe(8000);
    const warned = await notices(c, "usage");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      severity: "info",
      title: "Pesanan bulan ini mencapai 80% kuota paket Growth",
      data: { metric: "orders", value: 8000, limit: 10_000, period: thisMonth() },
    });
    await order();
    expect(await notices(c, "usage")).toHaveLength(1);
    await h.system.db.execute(
      sql`UPDATE usage_counter SET value = 9999 WHERE tenant_id = ${tenantId} AND metric = 'orders'`,
    );
    await order();
    const over = await notices(c, "usage");
    expect(over).toHaveLength(2);
    expect(over[0]).toMatchObject({ severity: "warning", title: "Pesanan bulan ini melewati kuota paket Growth" });
    // nothing is refused for being over quota: an order that came in is an order to ship
    await order();
    expect((await state(c)).usage.orders.value).toBe(10_001);
    expect(await notices(c, "usage")).toHaveLength(2);
  });

  it("shows a refused Xendit request, retries outages, closes withdrawn invoices at Xendit, and records late money", async () => {
    const { c, tenantId } = await business();
    xendit.failNext(400, { error_code: "API_VALIDATION_ERROR", message: "payer_email is invalid" });
    const inv = (await choose(c, "business")).body.pendingInvoice as InvoiceBody;
    expect(inv).toMatchObject({ kind: "upgrade", creditAmount: 0, amount: 2_499_000 });
    await drain(tenantId);
    expect(await invoiceOf(c, inv.id)).toMatchObject({
      status: "failed",
      error: "Xendit menjawab 400 (API_VALIDATION_ERROR).",
      invoiceUrl: null,
    });
    expect((await state(c)).pendingInvoice).toBeNull();

    // Xendit is down: the job fails so BullMQ retries it; the invoice waits
    xendit.failNext(503, { error_code: "SERVER_ERROR", message: "try again" });
    const again = (await choose(c, "business")).body.pendingInvoice as InvoiceBody;
    expect(again.id).not.toBe(inv.id);
    const failures: { job: string; error: unknown }[] = [];
    await worker.runOutbox(tenantId, { failures });
    expect(failures.map((f) => f.job)).toEqual(["billing.invoice_create"]);
    expect(await invoiceOf(c, again.id)).toMatchObject({ status: "pending", invoiceUrl: null });
    await worker.runJob(billingInvoiceCreateJob, { invoiceId: again.id }, tenantId);
    expect((await invoiceOf(c, again.id)).invoiceUrl).toContain(xendit.url);

    // a waiting move up can be withdrawn, once; its Xendit page is closed
    const voided = await c.post(`/v1/billing/invoices/${again.id}/void`);
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe("void");
    expect(await drain(tenantId)).toContain("billing.invoice_expire");
    expect(xendit.expired.has(xendit.byExternalId(again.id)!.id)).toBe(true);
    expect((await c.post(`/v1/billing/invoices/${again.id}/void`)).body.code).toBe("invoice.not_pending");
    expect((await c.post("/v1/billing/invoices/01HZZZZZZZZZZZZZZZZZZZZZZZ/void")).status).toBe(404);

    // a transfer that was already on its way still arrives: recorded and announced, the plan unchanged
    await pay(tenantId, again.id);
    expect(await invoiceOf(c, again.id)).toMatchObject({ status: "paid", paidAmount: 2_499_000 });
    expect(await state(c)).toMatchObject({ status: "trialing", plan: { code: "growth" } });
    const late = await notices(c, "late_payment");
    expect(late).toHaveLength(1);
    expect(late[0]!.title).toBe(`Pembayaran ${again.number} diterima untuk tagihan yang sudah tidak berlaku`);

    // withdrawn while Xendit was still making the page: the page is closed as soon as it exists
    const racing = (await choose(c, "business")).body.pendingInvoice as InvoiceBody;
    xendit.beforeCreate = async () => {
      expect((await c.post(`/v1/billing/invoices/${racing.id}/void`)).status).toBe(200);
    };
    expect(await drain(tenantId)).toEqual(expect.arrayContaining(["billing.invoice_create", "billing.invoice_expire"]));
    expect(xendit.expired.has(xendit.byExternalId(racing.id)!.id)).toBe(true);
    expect(await invoiceOf(c, racing.id)).toMatchObject({ status: "void" });

    // Xendit's own expiry closes a waiting invoice; the trial goes on
    const third = (await choose(c, "business")).body.pendingInvoice as InvoiceBody;
    await drain(tenantId);
    await pay(tenantId, third.id, "EXPIRED");
    expect((await invoiceOf(c, third.id)).status).toBe("expired");
    expect((await state(c)).status).toBe("trialing");
    // the month after the trial, chosen and withdrawn by hand while the trial runs
    const keep = (await choose(c, "growth")).body.pendingInvoice as InvoiceBody;
    expect((await c.post(`/v1/billing/invoices/${keep.id}/void`)).status).toBe(200);
    expect((await c.get("/v1/billing/invoices")).body.items.map((i: InvoiceBody) => i.status)).toEqual([
      "void",
      "expired",
      "void",
      "paid",
      "failed",
    ]);

    // the full export carries the subscription history and the invoices
    const files = worker.ctx
      .get(ExportRenderService, { strict: false })
      .sheets()
      .map((s) => s.file);
    expect(files).toEqual(expect.arrayContaining(["langganan.csv", "tagihan.csv"]));
  });
});
