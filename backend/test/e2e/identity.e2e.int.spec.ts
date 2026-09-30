import type { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemContext } from "../../src/common/context/request-context";
import { UsersService } from "../../src/modules/identity/users.service";
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

async function roleId(c: ReturnType<typeof client>, name: string): Promise<string> {
  const res = await c.get("/v1/roles");
  return (res.body.items as { id: string; name: string }[]).find((r) => r.name === name)!.id;
}

/** Invites `email` with `role`, delivers the email through the worker, and accepts it. */
async function addMember(
  owner: ReturnType<typeof client>,
  tenantId: string,
  role: string,
  email = uniqueEmail("staf"),
) {
  const invite = await owner.post("/v1/invitations", { email, roleId: await roleId(owner, role) });
  expect(invite.status).toBe(201);
  await worker.runOutbox(tenantId);
  const token = tokenFrom(worker.email.lastTo(email)!.text);
  const member = client(app);
  const accepted = await member.post("/v1/auth/invitations/accept", { token, name: "Budi", password: PASSWORD });
  expect(accepted.status).toBe(201);
  return { member, email, me: accepted.body as MeBody, invitationId: invite.body.id as string };
}

describe("signup and session (PRD 7.1, technology doc 5.3)", () => {
  it("creates the business, the six built-in roles, a default warehouse, and signs the Owner in", async () => {
    const { c, me } = await signup(app, { businessName: "Toko Kaos Rina" });
    expect(me.roles.map((r) => r.name)).toEqual(["Owner"]);
    expect(me.permissions).toContain("settings:user");
    expect(me.tenant.slug).toMatch(/^toko-kaos-rina-[0-9a-f]{4}$/);
    expect((await c.get("/v1/me")).body.user.id).toBe(me.user.id);

    const roles = await c.get("/v1/roles");
    expect((roles.body.items as { name: string }[]).map((r) => r.name).sort()).toEqual(
      ["Admin", "CS", "Finance", "Gudang", "Owner", "Viewer"].sort(),
    );
    const wh = await h.worker.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${me.tenant.id}, true)`);
      return (await tx.execute<{ code: string; is_default: boolean }>(sql`SELECT code, is_default FROM warehouse`))
        .rows;
    });
    expect(wh).toEqual([{ code: "UTAMA", is_default: true }]);
  });

  it("sets an HttpOnly, SameSite=Lax session cookie", async () => {
    const res = await client(app).post("/v1/auth/signup", {
      businessName: "Toko Cookie",
      name: "Rina",
      email: uniqueEmail(),
      password: PASSWORD,
    });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/^os_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it("rejects invalid input with 422 and field paths", async () => {
    const res = await client(app).post("/v1/auth/signup", {
      businessName: "T",
      name: "",
      email: "bukan-email",
      password: "pendek",
    });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect((res.body.errors as { path: string }[]).map((e) => e.path).sort()).toEqual(
      ["businessName", "email", "name", "password"].sort(),
    );
  });

  it("requires a session everywhere except public routes", async () => {
    const res = await client(app).get("/v1/users");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.required");
    const forged = await client(app)
      .get("/v1/me")
      .set("Cookie", "os_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(forged.status).toBe(401);
  });

  it("logs in, logs out, and forgets the session", async () => {
    const { email } = await signup(app);
    const c = client(app);
    expect((await c.post("/v1/auth/login", { email, password: "salah-sekali-123" })).body.code).toBe(
      "auth.invalid_credentials",
    );
    expect((await c.post("/v1/auth/login", { email: email.toUpperCase(), password: PASSWORD })).status).toBe(200);
    expect((await c.get("/v1/me")).status).toBe(200);
    expect((await c.post("/v1/auth/logout")).status).toBe(204);
    expect((await c.get("/v1/me")).status).toBe(401);
  });

  it("answers an unknown email exactly like a wrong password", async () => {
    const res = await client(app).post("/v1/auth/login", { email: uniqueEmail("tidak-ada"), password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.invalid_credentials");
  });

  it("locks the account after five failures and refuses even the right password while locked", async () => {
    const { email } = await signup(app);
    const c = client(app);
    for (let i = 0; i < 5; i++) {
      expect((await c.post("/v1/auth/login", { email, password: `salah-${i}-abcdef` })).status).toBe(401);
    }
    const locked = await c.post("/v1/auth/login", { email, password: PASSWORD });
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe("auth.locked");
    expect(locked.body.locked_until).toBeDefined();
    // a wrong guess while locked gets the same answer, so it reveals nothing
    expect((await c.post("/v1/auth/login", { email, password: "tebakan-lain-1" })).body.code).toBe("auth.locked");
  });

  it("asks which business when one email and password match several", async () => {
    const email = uniqueEmail("multi");
    const a = await signup(app, { email, businessName: "Toko Satu" });
    const b = await signup(app, { email, businessName: "Toko Dua" });
    const c = client(app);
    const res = await c.post("/v1/auth/login", { email, password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("auth.tenant_choice_required");
    expect((res.body.tenants as { slug: string }[]).map((t) => t.slug).sort()).toEqual(
      [a.me.tenant.slug, b.me.tenant.slug].sort(),
    );
    const chosen = await c.post("/v1/auth/login", { email, password: PASSWORD, tenant: b.me.tenant.slug });
    expect(chosen.status).toBe(200);
    expect(chosen.body.tenant.id).toBe(b.me.tenant.id);
  });

  it("rate limits signup per client IP and says when to retry", async () => {
    const c = client(app);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await c.post("/v1/auth/signup", {
        businessName: "Toko Spam",
        name: "S",
        email: uniqueEmail(),
        password: PASSWORD,
      });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.body.code).toBe("rate.limited");
        expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      }
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe("team invitations (PRD FR-USR-03)", () => {
  it("invites, emails a link through the worker, and the new member signs in with the invited role", async () => {
    const { c: owner, me } = await signup(app);
    const { member, me: memberMe, email } = await addMember(owner, me.tenant.id, "Gudang");
    expect(memberMe.roles.map((r) => r.name)).toEqual(["Gudang"]);
    expect(memberMe.tenant.id).toBe(me.tenant.id);
    expect(memberMe.permissions).not.toContain("settings:user");

    const denied = await member.get("/v1/users");
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("auth.permission_denied");

    const users = await owner.get("/v1/users");
    expect((users.body.items as { email: string }[]).map((u) => u.email)).toContain(email);
    expect((await owner.get("/v1/invitations")).body.items).toEqual([]);
  });

  it("shows the invitation before acceptance, and a resend invalidates the earlier link", async () => {
    const { c: owner, me } = await signup(app, { businessName: "Toko Undangan" });
    const email = uniqueEmail("kasir");
    const invite = await owner.post("/v1/invitations", { email, roleId: await roleId(owner, "CS") });
    await worker.runOutbox(me.tenant.id);
    const first = tokenFrom(worker.email.lastTo(email)!.text);
    const preview = await client(app).post("/v1/auth/invitations/inspect", { token: first });
    expect(preview.body).toMatchObject({ tenantName: "Toko Undangan", email, roleName: "CS" });

    expect((await owner.post(`/v1/invitations/${invite.body.id}/resend`)).status).toBe(200);
    await worker.runOutbox(me.tenant.id);
    const second = tokenFrom(worker.email.lastTo(email)!.text);
    expect(second).not.toBe(first);
    const stale = await client(app).post("/v1/auth/invitations/inspect", { token: first });
    expect(stale.status).toBe(404);
    expect(stale.body.code).toBe("invitation.invalid");
    expect((await client(app).post("/v1/auth/invitations/inspect", { token: second })).status).toBe(200);
  });

  it("refuses duplicate invitations and revoked links", async () => {
    const { c: owner, me, email: ownerEmail } = await signup(app);
    const viewer = await roleId(owner, "Viewer");
    expect((await owner.post("/v1/invitations", { email: ownerEmail, roleId: viewer })).body.code).toBe(
      "user.email_taken",
    );
    const email = uniqueEmail();
    const first = await owner.post("/v1/invitations", { email, roleId: viewer });
    expect((await owner.post("/v1/invitations", { email, roleId: viewer })).body.code).toBe("invitation.already_open");
    await worker.runOutbox(me.tenant.id);
    const token = tokenFrom(worker.email.lastTo(email)!.text);
    expect((await owner.delete(`/v1/invitations/${first.body.id}`)).status).toBe(204);
    const res = await client(app).post("/v1/auth/invitations/accept", { token, name: "X", password: PASSWORD });
    expect(res.status).toBe(404);
  });
});

describe("user management (PRD FR-USR-01, 02)", () => {
  it("keeps at least one active Owner and never lets a user disable themselves", async () => {
    const { c: owner, me } = await signup(app);
    const self = await owner.patch(`/v1/users/${me.user.id}`, { status: "disabled" });
    expect(self.body.code).toBe("user.cannot_disable_self");
    const demote = await owner.put(`/v1/users/${me.user.id}/roles`, { roleIds: [await roleId(owner, "Admin")] });
    expect(demote.body.code).toBe("role.last_owner");

    const { me: second } = await addMember(owner, me.tenant.id, "Owner");
    const ok = await owner.put(`/v1/users/${me.user.id}/roles`, { roleIds: [await roleId(owner, "Admin")] });
    expect(ok.status).toBe(200);
    expect(ok.body.roles.map((r: { name: string }) => r.name)).toEqual(["Admin"]);
    expect(second.roles.map((r) => r.name)).toEqual(["Owner"]);
  });

  it("disabling a user ends their sessions immediately", async () => {
    const { c: owner, me } = await signup(app);
    const { member, me: m } = await addMember(owner, me.tenant.id, "CS");
    expect((await member.get("/v1/me")).status).toBe(200);
    expect((await owner.patch(`/v1/users/${m.user.id}`, { status: "disabled" })).body.status).toBe("disabled");
    expect((await member.get("/v1/me")).status).toBe(401);
  });

  it("applies role changes on the next request, without signing in again", async () => {
    const { c: owner, me } = await signup(app);
    const { member, me: m } = await addMember(owner, me.tenant.id, "Viewer");
    expect((await member.get("/v1/me")).body.permissions).not.toContain("inventory:adjust");
    await owner.put(`/v1/users/${m.user.id}/roles`, { roleIds: [await roleId(owner, "Admin")] });
    expect((await member.get("/v1/me")).body.permissions).toContain("inventory:adjust");
  });

  it("limits a user to chosen warehouses", async () => {
    const { c: owner, me } = await signup(app);
    const { member, me: m } = await addMember(owner, me.tenant.id, "Gudang");
    const warehouseId = await h.worker.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${me.tenant.id}, true)`);
      return (await tx.execute<{ id: string }>(sql`SELECT id FROM warehouse LIMIT 1`)).rows[0]!.id;
    });
    const res = await owner.put(`/v1/users/${m.user.id}/scopes`, { warehouseIds: [warehouseId] });
    expect(res.body.warehouseIds).toEqual([warehouseId]);
    expect(res.body.storeIds).toBeNull();
    expect((await member.get("/v1/me")).body.warehouseScope).toEqual([warehouseId]);
    await owner.put(`/v1/users/${m.user.id}/scopes`, { warehouseIds: null });
    expect((await member.get("/v1/me")).body.warehouseScope).toBeNull();
  });

  it("uses row_version for optimistic locking (ETag / If-Match)", async () => {
    const { c: owner, me } = await signup(app);
    const got = await owner.get(`/v1/users/${me.user.id}`);
    const etag = got.headers.etag as string;
    expect(etag).toMatch(/^"\d+"$/);
    expect((await owner.patch(`/v1/users/${me.user.id}`, { name: "Rina A." }).set("If-Match", etag)).status).toBe(200);
    const stale = await owner.patch(`/v1/users/${me.user.id}`, { name: "Rina B." }).set("If-Match", etag);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("row.stale");
  });

  it("refuses to grant permissions the acting user does not have", async () => {
    const { c: owner, me } = await signup(app);
    const { me: m } = await addMember(owner, me.tenant.id, "Viewer");
    const users = worker.ctx.get(UsersService, { strict: false });
    const limited = { ...systemContext(me.tenant.id), permissions: new Set(["settings:user", "order:read"]) };
    const ownerRole = await roleId(owner, "Owner");
    await expect(users.setRoles(limited, m.user.id, [ownerRole])).rejects.toMatchObject({
      code: "role.privilege_escalation",
    });
  });

  it("records role changes in the audit log with the acting user", async () => {
    const { c: owner, me } = await signup(app);
    const { me: m } = await addMember(owner, me.tenant.id, "Viewer");
    await owner.put(`/v1/users/${m.user.id}/roles`, { roleIds: [await roleId(owner, "Finance")] });
    const res = await owner.get("/v1/audit-logs?entity_type=user_role&limit=10");
    expect(res.status).toBe(200);
    const byOwner = (res.body.items as { actorType: string; actorId: string; action: string }[]).filter(
      (e) => e.actorId === me.user.id,
    );
    expect(byOwner.map((e) => e.action).sort()).toEqual(["delete", "insert"]);
    expect(byOwner.every((e) => e.actorType === "user")).toBe(true);
  });
});

describe("passwords (PRD FR-USR-03)", () => {
  it("resets through an emailed one-time link, signs out old sessions, and unlocks", async () => {
    const { c: oldSession, me, email } = await signup(app);
    const c = client(app);
    expect((await c.post("/v1/auth/password-reset", { email })).status).toBe(202);
    await worker.runOutbox(me.tenant.id);
    const mail = worker.email.lastTo(email)!;
    expect(mail.subject).toBe("Atur ulang kata sandi OmniSeller");
    const token = tokenFrom(mail.text);

    const newPassword = "kata-sandi-baru-456";
    expect((await c.post("/v1/auth/password-reset/confirm", { token, password: newPassword })).status).toBe(204);
    expect((await oldSession.get("/v1/me")).status).toBe(401);
    expect((await c.post("/v1/auth/login", { email, password: PASSWORD })).status).toBe(401);
    expect((await c.post("/v1/auth/login", { email, password: newPassword })).status).toBe(200);
    const reuse = await client(app).post("/v1/auth/password-reset/confirm", { token, password: "lagi-lagi-lagi-1" });
    expect(reuse.body.code).toBe("auth.reset_token_invalid");
  });

  it("answers 202 for unknown emails and sends nothing", async () => {
    const email = uniqueEmail("hantu");
    expect((await client(app).post("/v1/auth/password-reset", { email })).status).toBe(202);
    expect(worker.email.lastTo(email)).toBeUndefined();
  });

  it("changes the own password, keeping only the current session", async () => {
    const { c: here, email } = await signup(app);
    const elsewhere = client(app);
    await elsewhere.post("/v1/auth/login", { email, password: PASSWORD });
    const wrong = await here.post("/v1/me/password", {
      currentPassword: "bukan-ini-123",
      newPassword: "baru-sekali-789",
    });
    expect(wrong.status).toBe(422);
    expect(
      (await here.post("/v1/me/password", { currentPassword: PASSWORD, newPassword: "baru-sekali-789" })).status,
    ).toBe(204);
    expect((await here.get("/v1/me")).status).toBe(200);
    expect((await elsewhere.get("/v1/me")).status).toBe(401);
  });
});
