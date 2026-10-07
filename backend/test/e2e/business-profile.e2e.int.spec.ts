import type { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDate } from "../../src/common/time-zone";
import type { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { businessLegalAlertJob } from "../../src/modules/business/business.jobs";
import { addMonths } from "../../src/modules/business/business-plan";
import { ExportRenderService } from "../../src/modules/exports/export-render.service";
import { scanLegalReminders } from "../../src/scheduler/legal-scan";
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
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n").toString("base64");
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("logo"),
]).toString("base64");
const today = () => localDate("Asia/Jakarta", new Date());
const plus = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function roleId(c: Client, name: string): Promise<string> {
  const res = await c.get("/v1/roles");
  return (res.body.items as { id: string; name: string }[]).find((r) => r.name === name)!.id;
}

async function addMember(owner: Client, tenantId: string, role: string) {
  const email = uniqueEmail("staf");
  const invite = await owner.post("/v1/invitations", { email, roleId: await roleId(owner, role) });
  expect(invite.status).toBe(201);
  await worker.runOutbox(tenantId);
  const token = tokenFrom(worker.email.lastTo(email)!.text);
  const member = client(app);
  const accepted = await member.post("/v1/auth/invitations/accept", { token, name: "Budi", password: PASSWORD });
  expect(accepted.status).toBe(201);
  return { member, me: accepted.body as MeBody };
}

async function document(c: Client, body: Record<string, unknown>) {
  return c.post("/v1/business-documents", { fileName: "dokumen.pdf", content: PDF, ...body });
}

describe("business profile and legal documents (PRD 6.13, Permendag 19/2026; backend doc 8.29)", () => {
  it("saves the profile with If-Match, reads numbers as typed, and renames the business", async () => {
    const { c } = await signup(app, { businessName: "Toko Uji Coba" });
    const first = await c.get("/v1/business-profile");
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe('"0"');
    expect(first.body).toMatchObject({
      rowVersion: 0,
      name: "Toko Uji Coba",
      timezone: "Asia/Jakarta",
      currency: "IDR",
      nibStatus: "missing",
      documents: [],
    });

    const saved = await c
      .patch("/v1/business-profile", {
        name: "Toko Rina Jaya",
        timezone: "Asia/Makassar",
        address: { line1: "Jl. Melati No. 5", city: "Kota Bandung", province: "jawa barat", postalCode: "40132" },
        phone: "0812-3456-7890",
        nib: "1234 5678 90123",
        npwp: "12.345.678.9-012.000",
        pkp: true,
      })
      .set("If-Match", '"0"');
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.headers.etag).toBe('"1"');
    expect(saved.body).toMatchObject({
      rowVersion: 1,
      name: "Toko Rina Jaya",
      timezone: "Asia/Makassar",
      address: { province: "Jawa Barat" },
      phone: "081234567890",
      nib: "1234567890123",
      nibStatus: "registered",
      npwp: "123456789012000",
      pkp: true,
    });
    expect((await c.get("/v1/me")).body.tenant.name).toBe("Toko Rina Jaya");
    // somebody saved in between
    const stale = await c.patch("/v1/business-profile", { pkp: false }).set("If-Match", '"0"');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("row.stale");

    const refused = async (body: object) => (await c.patch("/v1/business-profile", body)).body;
    expect((await refused({ nib: "12345" })).errors).toEqual([{ path: "nib", message: "NIB terdiri dari 13 angka." }]);
    expect((await refused({ npwp: "1234" })).errors[0].path).toBe("npwp");
    expect((await refused({ timezone: "Europe/London" })).errors[0].path).toBe("timezone");
    expect((await refused({ nib: "1234567890123", nibInProcessSince: "2026-05-01" })).errors[0].path).toBe(
      "nibInProcessSince",
    );
    expect((await refused({ nib: null, nibInProcessSince: plus(today(), 3) })).errors[0].path).toBe(
      "nibInProcessSince",
    );

    // still getting the NIB: six months from the start
    const since = plus(today(), -10);
    const inProcess = await c.patch("/v1/business-profile", { nib: null, nibInProcessSince: since });
    expect(inProcess.body).toMatchObject({
      nib: null,
      nibStatus: "in_process",
      nibInProcessSince: since,
      nibDeadline: addMonths(since, 6),
    });
    // the NIB arrives: the process is over
    const registered = await c.patch("/v1/business-profile", { nib: "1234567890123" });
    expect(registered.body).toMatchObject({ nibStatus: "registered", nibInProcessSince: null, nibDeadline: null });
  });

  it("keeps legal documents with their files, renews, and removes them", async () => {
    const { c } = await signup(app);
    const nib = await document(c, { kind: "nib", number: "1234567890123", issuedOn: "2024-01-10" });
    expect(nib.status, JSON.stringify(nib.body)).toBe(201);
    expect(nib.body).toMatchObject({ kind: "nib", title: "NIB", status: "no_expiry", daysLeft: null });
    const until = plus(today(), 20);
    const sppkp = await document(c, {
      kind: "sppkp",
      title: "Surat Pengukuhan PKP",
      validUntil: until,
      fileName: "sppkp.png",
      content: PNG,
    });
    expect(sppkp.body).toMatchObject({ status: "expiring", daysLeft: 20, fileName: "sppkp.png" });

    // the file is read from its bytes, not its name
    const text = await document(c, {
      kind: "other",
      title: "Catatan",
      content: Buffer.from("bukan pdf").toString("base64"),
    });
    expect(text.status).toBe(422);
    expect(text.body.errors[0].path).toBe("content");
    // a WebP is fine for a logo, not for a legal document
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]).toString(
      "base64",
    );
    expect((await document(c, { kind: "other", title: "Foto", content: webp })).status).toBe(422);
    const backwards = await document(c, { kind: "deed", issuedOn: "2025-02-01", validUntil: "2025-01-01" });
    expect(backwards.body.code).toBe("business_document.dates");

    // a browser asking with the version it kept gets the documents added since, never 304
    const asBrowser = await c.get("/v1/business-profile").set("If-None-Match", '"0"');
    expect(asBrowser.status).toBe(200);
    expect(asBrowser.headers["cache-control"]).toBe("no-store");
    expect(asBrowser.body.documents).toHaveLength(2);
    const file = await c.get(`/v1/business-documents/${nib.body.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("application/pdf");

    const renewed = await c.patch(`/v1/business-documents/${sppkp.body.id}`, { validUntil: plus(today(), 400) });
    expect(renewed.body).toMatchObject({ status: "valid", daysLeft: 400, title: "Surat Pengukuhan PKP" });
    const listed = (await c.get("/v1/business-profile")).body.documents as { id: string }[];
    expect(listed.map((d) => d.id).sort()).toEqual([nib.body.id, sppkp.body.id].sort());

    expect((await c.delete(`/v1/business-documents/${nib.body.id}`)).status).toBe(204);
    expect((await c.get(`/v1/business-documents/${nib.body.id}/file`)).status).toBe(404);
    const expired = await h.system.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM file_object WHERE purpose = 'legal_document' AND expires_at IS NOT NULL
           AND tenant_id = ${(await c.get("/v1/me")).body.tenant.id}`,
    );
    expect(expired.rows[0]!.n).toBe("1");
  });

  it("uploads a logo, replaces it, and removes it", async () => {
    const { c, me } = await signup(app);
    expect((await c.get("/v1/business-profile/logo")).status).toBe(404);
    const set = await c.put("/v1/business-profile/logo", { content: PNG });
    expect(set.body.hasLogo).toBe(true);
    const logo = await c.get("/v1/business-profile/logo");
    expect(logo.status).toBe(200);
    expect(logo.headers["content-type"]).toContain("image/png");
    await c.put("/v1/business-profile/logo", { content: PNG });
    const files = await h.system.db.execute<{ live: string; gone: string }>(
      sql`SELECT count(*) FILTER (WHERE expires_at IS NULL)::text AS live, count(*) FILTER (WHERE expires_at IS NOT NULL)::text AS gone
            FROM file_object WHERE purpose = 'logo' AND tenant_id = ${me.tenant.id}`,
    );
    expect(files.rows[0]).toEqual({ live: "1", gone: "1" });
    expect((await c.put("/v1/business-profile/logo", { content: PDF })).status).toBe(422);
    expect((await c.delete("/v1/business-profile/logo")).body.hasLogo).toBe(false);
    expect((await c.get("/v1/business-profile/logo")).status).toBe(404);
  });

  it("reminds the keeper of legal papers before documents end and before the NIB deadline, once each", async () => {
    const { c, me, email } = await signup(app);
    const { me: admin } = await addMember(c, me.tenant.id, "Admin");
    const t = today();
    await document(c, { kind: "sppkp", validUntil: plus(t, 20) });
    await document(c, { kind: "business_license", validUntil: plus(t, 5) });
    await document(c, { kind: "deed", validUntil: plus(t, -1) });
    await document(c, { kind: "other", title: "Masih lama", validUntil: plus(t, 200) });
    // the NIB's six months end in 10 days
    const since = addMonths(plus(t, 10), -6);
    expect((await c.patch("/v1/business-profile", { nibInProcessSince: since })).status).toBe(200);

    // the hourly scan finds this business; the job sends what is due
    const added: { payload: { tenantId: string } }[] = [];
    const queues = {
      get: () => ({ add: async (_n: string, payload: { tenantId: string }) => added.push({ payload }) }),
    };
    await scanLegalReminders(h.system, queues as unknown as QueueRegistry, new JobRegistry(JOB_DEFINITIONS));
    expect(added.map((a) => a.payload.tenantId)).toContain(me.tenant.id);
    await worker.runJob(businessLegalAlertJob, { slot: "s1" }, me.tenant.id);
    await worker.runOutbox(me.tenant.id);

    const notices = (await c.get("/v1/notifications?limit=20")).body.items as {
      kind: string;
      severity: string;
      title: string;
    }[];
    const legal = notices.filter((n) => n.kind === "legal.reminder");
    expect(legal.map((n) => [n.severity, n.title]).sort()).toEqual(
      [
        ["critical", "Akta pendirian sudah habis berlaku"],
        ["warning", "Batas proses NIB segera berakhir"],
        ["warning", "Izin usaha segera habis berlaku"],
        ["warning", "SPPKP segera habis berlaku"],
      ].sort(),
    );
    expect(worker.email.lastTo(email)?.subject).toBeTruthy();
    // the Admin does not keep the business's papers
    const adminNotices = await h.system.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM notification WHERE user_id = ${admin.user.id} AND kind = 'legal.reminder'`,
    );
    expect(adminNotices.rows[0]!.n).toBe("0");

    // claimed: nothing again until the next stage
    await worker.runJob(businessLegalAlertJob, { slot: "s2" }, me.tenant.id);
    const again = (await c.get("/v1/notifications?limit=20")).body.items as { kind: string }[];
    expect(again.filter((n) => n.kind === "legal.reminder")).toHaveLength(4);
    added.length = 0;
    await scanLegalReminders(h.system, queues as unknown as QueueRegistry, new JobRegistry(JOB_DEFINITIONS));
    expect(added.map((a) => a.payload.tenantId)).not.toContain(me.tenant.id);

    // a renewed end date and a corrected NIB start date start their reminders again
    const docs = (await c.get("/v1/business-profile")).body.documents as { id: string; title: string }[];
    const licence = docs.find((d) => d.title === "Izin usaha")!;
    await c.patch(`/v1/business-documents/${licence.id}`, { validUntil: plus(t, 25) });
    await c.patch("/v1/business-profile", { nibInProcessSince: addMonths(plus(t, 20), -6) });
    await worker.runJob(businessLegalAlertJob, { slot: "s3" }, me.tenant.id);
    const renewed = ((await c.get("/v1/notifications?limit=20")).body.items as { kind: string; title: string }[])
      .filter((n) => n.kind === "legal.reminder")
      .map((n) => n.title);
    expect(renewed).toHaveLength(6);
    expect(renewed.filter((x) => x === "Izin usaha segera habis berlaku")).toHaveLength(2);
    expect(renewed.filter((x) => x === "Batas proses NIB segera berakhir")).toHaveLength(2);
  });

  it("asks the Owner on the dashboard for a missing NIB and documents running out, not the Admin", async () => {
    const { c, me } = await signup(app);
    const { member: admin } = await addMember(c, me.tenant.id, "Admin");
    await document(c, { kind: "sppkp", validUntil: plus(today(), -3) });
    const tasks = (await c.get("/v1/dashboard?range=today")).body.tasks as { kind: string; severity: string }[];
    expect(tasks.filter((x) => x.kind.startsWith("legal_"))).toEqual([
      expect.objectContaining({ kind: "legal_documents", severity: "critical" }),
      expect.objectContaining({ kind: "legal_nib", severity: "warning" }),
    ]);
    const adminTasks = (await admin.get("/v1/dashboard?range=today")).body.tasks as { kind: string }[];
    expect(adminTasks.filter((x) => x.kind.startsWith("legal_"))).toEqual([]);
    expect((await admin.get("/v1/business-profile")).status).toBe(403);
  });

  it("records who changed the NIB and the documents in the audit log, and exports both", async () => {
    const { c } = await signup(app);
    await c.patch("/v1/business-profile", { npwp: "123456789012000" });
    await c.patch("/v1/business-profile", { nib: "1234567890123" });
    await document(c, { kind: "nib", number: "1234567890123" });
    const log = (await c.get("/v1/audit-logs?entity_type=business_profile,business_document")).body.items as {
      entityType: string;
      change: string;
      label: string | null;
      actor: { name: string | null };
      changes: { field: string; before: unknown; after: unknown }[];
    }[];
    expect(log.map((e) => [e.entityType, e.change, e.label])).toEqual([
      ["business_document", "created", "NIB"],
      ["business_profile", "updated", null],
      ["business_profile", "created", null],
    ]);
    expect(log[1]!.changes).toEqual([{ field: "nib", before: null, after: "1234567890123" }]);
    expect(log.every((e) => e.actor.name === "Rina")).toBe(true);

    const files = worker.ctx
      .get(ExportRenderService, { strict: false })
      .sheets()
      .map((s) => s.file);
    expect(files).toEqual(expect.arrayContaining(["profil_bisnis.csv", "dokumen_legalitas.csv"]));
  });
});
