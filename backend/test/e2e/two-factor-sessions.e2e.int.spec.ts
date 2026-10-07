import type { INestApplication } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { generate } from "otplib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Client,
  client,
  type MeBody,
  PASSWORD,
  signup,
  startApi,
  startWorker,
  tokenFrom,
  uniqueEmail,
} from "../setup/app";
import { testHandles } from "../setup/handles";

/** Verification in two steps and signed-in devices (PRD FR-USR-05, 06; backend doc 8.30). */

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

const STEP_SECONDS = 30;
/**
 * The 30-second step a scenario starts in. Codes of this step and the next are accepted for at least 30
 * seconds from now (the api allows one step of drift either way), so scenarios use only those two, and
 * forget the last used step (`forgetLastStep`) where a third code is needed.
 */
const stepNow = () => Math.floor(Date.now() / 1000 / STEP_SECONDS);
const codeAt = (secret: string, step: number) => generate({ secret, epoch: step * STEP_SECONDS + 1 });
const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const UA_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";

async function forgetLastStep(userId: string): Promise<void> {
  await h.system.db.execute(sql`UPDATE "user" SET totp_last_step = NULL WHERE id = ${userId}`);
}

/** Turns two-step verification on for the signed-in client with the code of `step`. */
async function enable(c: Client, step = stepNow()) {
  const setup = await c.post("/v1/me/two-factor/setup", { password: PASSWORD });
  expect(setup.status).toBe(200);
  const secret = setup.body.secret as string;
  const on = await c.post("/v1/me/two-factor/enable", { code: await codeAt(secret, step) });
  expect(on.status).toBe(200);
  return { secret, backupCodes: on.body.backupCodes as string[], step };
}

/** Logs in with the password and returns the challenge of the second step. */
async function passwordStep(c: Client, email: string): Promise<string> {
  const res = await c.post("/v1/auth/login", { email, password: PASSWORD });
  expect(res.status).toBe(401);
  expect(res.body.code).toBe("auth.two_factor_required");
  return res.body.challenge as string;
}

async function roleId(c: Client, name: string): Promise<string> {
  const res = await c.get("/v1/roles");
  return (res.body.items as { id: string; name: string }[]).find((r) => r.name === name)!.id;
}

/** Invites a member with `role`, delivers the email through the worker, and accepts it. */
async function addMember(owner: Client, tenantId: string, role: string) {
  const email = uniqueEmail("staf");
  expect((await owner.post("/v1/invitations", { email, roleId: await roleId(owner, role) })).status).toBe(201);
  await worker.runOutbox(tenantId);
  const member = client(app);
  const accepted = await member.post("/v1/auth/invitations/accept", {
    token: tokenFrom(worker.email.lastTo(email)!.text),
    name: "Budi",
    password: PASSWORD,
  });
  expect(accepted.status).toBe(201);
  return { member, email, me: accepted.body as MeBody };
}

describe("turning two-step verification on (FR-USR-05)", () => {
  it("asks the password, shows a QR code, keeps the secret sealed, and confirms with a code", async () => {
    const { c, me, email } = await signup(app);
    const elsewhere = client(app);
    expect((await elsewhere.post("/v1/auth/login", { email, password: PASSWORD })).status).toBe(200);

    const before = await c.get("/v1/me/two-factor");
    expect(before.body).toEqual({ enabled: false, enabledAt: null, backupCodesLeft: 0, recommended: true });
    const wrong = await c.post("/v1/me/two-factor/setup", { password: "bukan-sandinya-1" });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors).toEqual([{ path: "password", message: "Kata sandi salah." }]);
    expect((await c.post("/v1/me/two-factor/enable", { code: "123456" })).body.code).toBe("two_factor.not_started");

    const setup = await c.post("/v1/me/two-factor/setup", { password: PASSWORD });
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.uri).toBe(
      `otpauth://totp/OmniSeller:${encodeURIComponent(email)}?secret=${secret}&issuer=OmniSeller`,
    );
    expect(setup.body.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    const [row] = (
      await h.system.db.execute<{ sealed: Buffer; enabled: boolean }>(
        sql`SELECT totp_secret_enc AS sealed, totp_enabled AS enabled FROM "user" WHERE id = ${me.user.id}`,
      )
    ).rows;
    expect(row!.enabled).toBe(false);
    expect(Buffer.from(row!.sealed).toString("latin1")).not.toContain(secret);

    const step = stepNow();
    const bad = await c.post("/v1/me/two-factor/enable", { code: await codeAt(secret, step + 20) });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].path).toBe("code");
    const on = await c.post("/v1/me/two-factor/enable", { code: await codeAt(secret, step) });
    expect(on.status).toBe(200);
    expect(on.body.backupCodes).toHaveLength(10);
    for (const code of on.body.backupCodes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);

    const after = await c.get("/v1/me/two-factor");
    expect(after.body).toMatchObject({ enabled: true, backupCodesLeft: 10, recommended: true });
    expect(Date.parse(after.body.enabledAt)).toBeGreaterThan(Date.now() - 60_000);
    // this device stays signed in, the one signed in with the password alone does not
    expect((await c.get("/v1/me")).body.user.twoFactorEnabled).toBe(true);
    expect((await elsewhere.get("/v1/me")).status).toBe(401);
    expect((await c.post("/v1/me/two-factor/setup", { password: PASSWORD })).body.code).toBe(
      "two_factor.already_enabled",
    );

    // in the audit log under the user's own name
    const log = await c.get("/v1/audit-logs?entity_type=user");
    expect(log.body.items[0]).toMatchObject({
      actor: { type: "user", name: "Rina" },
      change: "updated",
      label: "Rina",
      changes: [{ field: "twoFactorEnabled", before: false, after: true }],
    });
  });

  it("is only advised for Owner and Admin", async () => {
    const { c: owner, me } = await signup(app);
    const { member } = await addMember(owner, me.tenant.id, "Gudang");
    expect((await member.get("/v1/me/two-factor")).body.recommended).toBe(false);
  });
});

describe("signing in with a second step", () => {
  it("asks a code after the password, takes each code once, and only then opens a session", async () => {
    const { c: owner, me, email } = await signup(app);
    const { secret, step } = await enable(owner);

    const c = client(app);
    const first = await c.post("/v1/auth/login", { email, password: PASSWORD });
    expect(first.status).toBe(401);
    expect(first.body).toMatchObject({ code: "auth.two_factor_required", expires_in: 300 });
    expect(first.headers["set-cookie"]).toBeUndefined();
    expect((await c.get("/v1/me")).status).toBe(401);
    const challenge = first.body.challenge as string;

    const wrong = await c.post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step + 20) });
    expect(wrong.body.code).toBe("auth.two_factor_invalid");
    // the code that turned it on was seen already
    const replay = await c.post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step) });
    expect(replay.body.code).toBe("auth.two_factor_invalid");
    const ok = await c.post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step + 1) });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(me.user.id);
    expect((await c.get("/v1/me")).status).toBe(200);
    // a challenge signs in once, and so does a code
    expect(
      (await client(app).post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step + 1) })).body
        .code,
    ).toBe("auth.two_factor_expired");
    const again = await passwordStep(client(app), email);
    expect(
      (await client(app).post("/v1/auth/login/two-factor", { challenge: again, code: await codeAt(secret, step + 1) }))
        .body.code,
    ).toBe("auth.two_factor_invalid");
  });

  it("counts wrong codes as failed logins: five in a row lock the account", async () => {
    const { c: owner, email } = await signup(app);
    const { secret, step } = await enable(owner);
    const c = client(app);
    const challenge = await passwordStep(c, email);
    for (let i = 0; i < 4; i++) {
      const res = await c.post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step + 20 + i) });
      expect(res.body.code).toBe("auth.two_factor_invalid");
    }
    const fifth = await c.post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step + 30) });
    expect(fifth.status).toBe(403);
    expect(fifth.body.code).toBe("auth.locked");
    // locked: even the password is refused now, and the challenge is gone
    expect((await c.post("/v1/auth/login", { email, password: PASSWORD })).body.code).toBe("auth.locked");
    expect(
      (await c.post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step + 1) })).body.code,
    ).toBe("auth.two_factor_expired");
  });

  it("allows five codes per challenge even when failures were reset meanwhile", async () => {
    const { c: owner, me, email } = await signup(app);
    const { secret, step } = await enable(owner);
    const c = client(app);
    const challenge = await passwordStep(c, email);
    for (let i = 0; i < 4; i++) {
      await c.post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step + 20 + i) });
    }
    // as after a successful login on another device
    await h.system.db.execute(sql`UPDATE "user" SET failed_login_count = 0 WHERE id = ${me.user.id}`);
    const fifth = await c.post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step + 30) });
    expect(fifth.body.code).toBe("auth.two_factor_expired");
    expect(
      (await c.post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step + 1) })).body.code,
    ).toBe("auth.two_factor_expired");
  });

  it("refuses the code step when the account was locked, disabled, or lost two-step since the password", async () => {
    const { c: owner, me } = await signup(app);
    const { member, me: m, email } = await addMember(owner, me.tenant.id, "Admin");
    const { secret, step } = await enable(member);
    const code = () => codeAt(secret, step + 1);

    // wrong passwords elsewhere lock the account between the two steps
    const first = client(app);
    const challenge = await passwordStep(first, email);
    for (let i = 0; i < 5; i++) await client(app).post("/v1/auth/login", { email, password: `salah-${i}-abcdef` });
    const locked = await first.post("/v1/auth/login/two-factor", { challenge, code: await code() });
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe("auth.locked");
    await h.system.db.execute(
      sql`UPDATE "user" SET locked_until = NULL, failed_login_count = 0 WHERE id = ${m.user.id}`,
    );

    // disabled by an Owner between the two steps
    const second = await passwordStep(client(app), email);
    expect((await owner.patch(`/v1/users/${m.user.id}`, { status: "disabled" })).status).toBe(200);
    const disabled = await client(app).post("/v1/auth/login/two-factor", { challenge: second, code: await code() });
    expect(disabled.body.code).toBe("auth.two_factor_expired");
  });

  it("refuses a challenge that is not one, and a body with both or neither kind of code", async () => {
    const c = client(app);
    const fake = await c.post("/v1/auth/login/two-factor", { challenge: "A".repeat(43), code: "123456" });
    expect(fake.body.code).toBe("auth.two_factor_expired");
    expect((await c.post("/v1/auth/login/two-factor", { challenge: "A".repeat(43) })).status).toBe(422);
    const both = await c.post("/v1/auth/login/two-factor", {
      challenge: "A".repeat(43),
      code: "123456",
      backupCode: "abcde-fghjk",
    });
    expect(both.status).toBe(422);
  });

  it("keeps two-step verification on after a password reset by email", async () => {
    const { c: owner, me, email } = await signup(app);
    const { secret, step } = await enable(owner);
    const c = client(app);
    expect((await c.post("/v1/auth/password-reset", { email })).status).toBe(202);
    await worker.runOutbox(me.tenant.id);
    const token = tokenFrom(worker.email.lastTo(email)!.text);
    const newPassword = "kata-sandi-baru-456";
    expect((await c.post("/v1/auth/password-reset/confirm", { token, password: newPassword })).status).toBe(204);
    const res = await c.post("/v1/auth/login", { email, password: newPassword });
    expect(res.body.code).toBe("auth.two_factor_required");
    const ok = await c.post("/v1/auth/login/two-factor", {
      challenge: res.body.challenge,
      code: await codeAt(secret, step + 1),
    });
    expect(ok.status).toBe(200);
  });
});

describe("backup codes and turning it off", () => {
  it("signs in once per backup code, replaces them on request, and turns off with the password and a code", async () => {
    const { c: owner, me, email } = await signup(app);
    const { secret, backupCodes, step } = await enable(owner);

    const c = client(app);
    const challenge = await passwordStep(c, email);
    // typed in capitals and with a space, it is still the code
    const typed = backupCodes[0]!.toUpperCase().replace("-", " ");
    expect((await c.post("/v1/auth/login/two-factor", { challenge, backupCode: typed })).status).toBe(200);
    expect((await c.get("/v1/me/two-factor")).body.backupCodesLeft).toBe(9);
    const reuse = await passwordStep(client(app), email);
    expect(
      (await client(app).post("/v1/auth/login/two-factor", { challenge: reuse, backupCode: backupCodes[0] })).body.code,
    ).toBe("auth.two_factor_invalid");

    expect((await owner.post("/v1/me/two-factor/backup-codes", { password: "bukan-sandinya-1" })).status).toBe(422);
    const fresh = await owner.post("/v1/me/two-factor/backup-codes", { password: PASSWORD });
    expect(fresh.status).toBe(200);
    expect(fresh.body.backupCodes).toHaveLength(10);
    expect(fresh.body.backupCodes).not.toContain(backupCodes[1]);
    const old = await passwordStep(client(app), email);
    expect(
      (await client(app).post("/v1/auth/login/two-factor", { challenge: old, backupCode: backupCodes[1] })).body.code,
    ).toBe("auth.two_factor_invalid");

    // off: the password and a code, not either alone
    const noCode = await owner.post("/v1/me/two-factor/disable", { password: PASSWORD });
    expect(noCode.status).toBe(422);
    const wrongCode = await owner.post("/v1/me/two-factor/disable", {
      password: PASSWORD,
      code: await codeAt(secret, step + 20),
    });
    expect(wrongCode.body.errors).toEqual([expect.objectContaining({ path: "code" })]);
    const wrongPassword = await owner.post("/v1/me/two-factor/disable", {
      password: "bukan-sandinya-1",
      backupCode: fresh.body.backupCodes[0],
    });
    expect(wrongPassword.body.errors).toEqual([{ path: "password", message: "Kata sandi salah." }]);
    await forgetLastStep(me.user.id);
    expect(
      (await owner.post("/v1/me/two-factor/disable", { password: PASSWORD, code: await codeAt(secret, step + 1) }))
        .status,
    ).toBe(204);
    expect((await owner.get("/v1/me/two-factor")).body).toEqual({
      enabled: false,
      enabledAt: null,
      backupCodesLeft: 0,
      recommended: true,
    });
    const [row] = (
      await h.system.db.execute<{ sealed: Buffer | null; codes: string[] }>(
        sql`SELECT totp_secret_enc AS sealed, totp_backup_codes AS codes FROM "user" WHERE id = ${me.user.id}`,
      )
    ).rows;
    expect(row).toEqual({ sealed: null, codes: [] });
    // a password alone signs in again
    expect((await client(app).post("/v1/auth/login", { email, password: PASSWORD })).status).toBe(200);
    expect((await owner.post("/v1/me/two-factor/backup-codes", { password: PASSWORD })).body.code).toBe(
      "two_factor.not_enabled",
    );
  });
});

describe("signed-in devices (FR-USR-06)", () => {
  it("lists this device first, signs one other device out, then all the others", async () => {
    const { c: here, email } = await signup(app);
    const phone = client(app);
    const laptop = client(app);
    expect(
      (await phone.post("/v1/auth/login", { email, password: PASSWORD }).set("User-Agent", UA_IPHONE)).status,
    ).toBe(200);
    expect(
      (await laptop.post("/v1/auth/login", { email, password: PASSWORD }).set("User-Agent", UA_FIREFOX)).status,
    ).toBe(200);

    const list = await here.get("/v1/me/sessions");
    expect(list.status).toBe(200);
    const items = list.body.items as { id: string; current: boolean; ip: string; browser: string; os: string }[];
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ current: true, ip: here.ip });
    expect(
      items
        .slice(1)
        .map((s) => [s.browser, s.os, s.ip])
        .sort(),
    ).toEqual(
      [
        ["Firefox", "Linux", laptop.ip],
        ["Safari", "iOS", phone.ip],
      ].sort(),
    );
    expect(items.every((s) => /^[A-Za-z0-9_-]{22}$/.test(s.id))).toBe(true);

    expect((await here.delete(`/v1/me/sessions/${items[0]!.id}`)).body.code).toBe("session.current");
    const phoneId = items.find((s) => s.os === "iOS")!.id;
    expect((await here.delete(`/v1/me/sessions/${phoneId}`)).status).toBe(204);
    expect((await phone.get("/v1/me")).status).toBe(401);
    expect((await here.delete(`/v1/me/sessions/${phoneId}`)).body.code).toBe("session.not_found");
    expect((await laptop.get("/v1/me")).status).toBe(200);

    expect((await here.post("/v1/me/sessions/revoke-others")).body).toEqual({ revoked: 1 });
    expect((await laptop.get("/v1/me")).status).toBe(401);
    expect((await here.get("/v1/me")).status).toBe(200);
    expect((await here.get("/v1/me/sessions")).body.items).toHaveLength(1);
  });
});

describe("an Owner and a member's devices", () => {
  it("signs a member out everywhere and turns off the two-step verification a member can no longer use", async () => {
    const { c: owner, me } = await signup(app);
    const { member, me: m, email } = await addMember(owner, me.tenant.id, "Admin");
    const { secret, step } = await enable(member);
    const listed = await owner.get("/v1/users");
    expect(listed.body.items.find((u: { id: string }) => u.id === m.user.id).twoFactorEnabled).toBe(true);

    expect((await owner.post(`/v1/users/${m.user.id}/sessions/revoke`)).body).toEqual({ revoked: 1 });
    expect((await member.get("/v1/me")).status).toBe(401);
    // acting on oneself keeps the session one acts from
    expect((await owner.post(`/v1/users/${me.user.id}/sessions/revoke`)).body).toEqual({ revoked: 0 });
    expect((await owner.get("/v1/me")).status).toBe(200);

    expect((await owner.post(`/v1/users/${me.user.id}/two-factor/reset`)).body.code).toBe("user.two_factor_reset_self");
    // signed in again with a code; turning it off ends that session too
    const again = client(app);
    const challenge = await passwordStep(again, email);
    const signedIn = await again.post("/v1/auth/login/two-factor", { challenge, code: await codeAt(secret, step + 1) });
    expect(signedIn.status).toBe(200);
    const reset = await owner.post(`/v1/users/${m.user.id}/two-factor/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body.twoFactorEnabled).toBe(false);
    expect((await again.get("/v1/me")).status).toBe(401);
    expect((await client(app).post("/v1/auth/login", { email, password: PASSWORD })).status).toBe(200);
    expect((await owner.post(`/v1/users/${m.user.id}/two-factor/reset`)).body.code).toBe("two_factor.not_enabled");

    const log = await owner.get(`/v1/audit-logs?entity_type=user&entity_id=${m.user.id}`);
    expect(log.body.items[0]).toMatchObject({
      actor: { type: "user", name: "Rina" },
      label: "Budi",
      changes: [{ field: "twoFactorEnabled", before: true, after: false }],
    });
    expect(log.body.items[1]).toMatchObject({
      actor: { type: "user", name: "Budi" },
      changes: [{ field: "twoFactorEnabled", before: false, after: true }],
    });
  });

  it("does not let a narrower role turn off the Owner's two-step verification, and needs settings:user", async () => {
    const { c: owner, me } = await signup(app);
    await enable(owner);
    const { member, me: m } = await addMember(owner, me.tenant.id, "Admin");
    // Admin does not manage the team
    expect((await member.post(`/v1/users/${me.user.id}/two-factor/reset`)).status).toBe(403);
    expect((await member.post(`/v1/users/${me.user.id}/sessions/revoke`)).status).toBe(403);

    // a team lead role: the team, and nothing of the money
    const lead = newId();
    await h.system.db.execute(
      sql`INSERT INTO role (id, tenant_id, name, is_system) VALUES (${lead}, ${me.tenant.id}, 'Kepala Tim', false)`,
    );
    await h.system.db.execute(sql`INSERT INTO role_permission (id, tenant_id, role_id, permission_id)
      SELECT gen_ulid(), ${me.tenant.id}, ${lead}, p.id FROM permission p
       WHERE p.code IN (${"settings:user"}, ${"order:read"})`);
    expect((await owner.put(`/v1/users/${m.user.id}/roles`, { roleIds: [lead] })).status).toBe(200);
    const refused = await member.post(`/v1/users/${me.user.id}/two-factor/reset`);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("user.two_factor_reset_forbidden");
    expect((await owner.get("/v1/me/two-factor")).body.enabled).toBe(true);
  });

  it("records disabling and enabling a member in the audit log", async () => {
    const { c: owner, me } = await signup(app);
    const { me: m } = await addMember(owner, me.tenant.id, "CS");
    expect((await owner.patch(`/v1/users/${m.user.id}`, { status: "disabled" })).status).toBe(200);
    const log = await owner.get(`/v1/audit-logs?entity_type=user&entity_id=${m.user.id}`);
    expect(log.body.items).toHaveLength(1);
    expect(log.body.items[0]).toMatchObject({
      label: "Budi",
      changes: [{ field: "status", before: "active", after: "disabled" }],
    });
    // secrets and login bookkeeping never reach the log
    const raw = JSON.stringify(log.body.items[0]);
    expect(raw).not.toMatch(/password_hash|totp_secret_enc|totp_backup_codes|failed_login_count/);
  });
});
