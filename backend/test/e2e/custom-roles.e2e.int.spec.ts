import type { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { ExportRenderService } from "../../src/modules/exports/export-render.service";
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
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";

/**
 * Custom roles (PRD FR-USR-01 and 14; backend doc 8.33): made from plan Growth on with permissions the maker
 * holds, felt by their holders on the next request, deleted once nobody needs them. After a move down they
 * keep working for whoever holds them, but cannot be made, changed, or handed to someone new.
 */
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

interface RoleBody {
  id: string;
  name: string;
  isSystem: boolean;
  description: string | null;
  permissions: string[];
  userCount: number;
}
interface AuditBody {
  change: string;
  label: string | null;
}

const roles = async (c: Client): Promise<RoleBody[]> => (await c.get("/v1/roles")).body.items;
const builtIn = async (c: Client, name: string) => (await roles(c)).find((r) => r.isSystem && r.name === name)!.id;
const audit = async (c: Client, entity: string): Promise<AuditBody[]> =>
  (await c.get(`/v1/audit-logs?entity_type=${entity}&limit=20`)).body.items;

/** Invites `email` with the role, delivers the email through the worker, and accepts it. */
async function addMember(owner: Client, tenantId: string, roleId: string, email = uniqueEmail("staf")) {
  const invite = await owner.post("/v1/invitations", { email, roleId });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  await worker.runOutbox(tenantId);
  const token = tokenFrom(worker.email.lastTo(email)!.text);
  const member = client(app);
  const accepted = await member.post("/v1/auth/invitations/accept", { token, name: "Budi", password: PASSWORD });
  expect(accepted.status).toBe(201);
  return { member, me: accepted.body as MeBody, invitationId: invite.body.id as string };
}

describe("custom roles (PRD FR-USR-01, backend doc 8.33)", () => {
  it("makes a role from chosen permissions, and its holders get every change on their next request", async () => {
    const { c, me } = await signup(app);
    // a new business is on the Growth trial, which has custom roles
    expect(me.plan).toEqual({ code: "growth", name: "Growth", features: expect.arrayContaining(["custom_roles"]) });

    const made = await c.post("/v1/roles", {
      name: "  Packer Malam ",
      description: "Mengemas pesanan shift malam",
      permissions: ["shipment:pack", "order:read", "order:read"],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({
      name: "Packer Malam",
      isSystem: false,
      description: "Mengemas pesanan shift malam",
      permissions: ["order:read", "shipment:pack"],
      userCount: 0,
    });
    const role = made.body as RoleBody;
    // one name per business whatever its case; known permissions, at least one; names up to 40 characters
    const twice = await c.post("/v1/roles", { name: "packer malam", permissions: ["order:read"] });
    expect([twice.status, twice.body.code]).toEqual([409, "role.name_taken"]);
    expect((await c.post("/v1/roles", { name: "VIEWER", permissions: ["order:read"] })).body.code).toBe(
      "role.name_taken",
    );
    expect((await c.post("/v1/roles", { name: "Kosong", permissions: [] })).status).toBe(422);
    expect((await c.post("/v1/roles", { name: "Asing", permissions: ["order:fly"] })).status).toBe(422);
    expect((await c.post("/v1/roles", { name: "x".repeat(41), permissions: ["order:read"] })).status).toBe(422);
    expect((await c.post("/v1/roles", { name: "   ", permissions: ["order:read"] })).status).toBe(422);

    const { member, me: m, invitationId } = await addMember(c, me.tenant.id, role.id);
    expect(m.roles).toEqual([{ id: role.id, name: "Packer Malam" }]);
    expect(m.permissions).toEqual(["order:read", "shipment:pack"]);
    expect((await roles(c)).find((r) => r.id === role.id)!.userCount).toBe(1);

    // changed: the holder has it on the next request, without signing in again
    const changed = await c.patch(`/v1/roles/${role.id}`, {
      permissions: ["order:read", "shipment:pack", "shipment:print"],
      description: null,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({
      permissions: ["order:read", "shipment:pack", "shipment:print"],
      description: null,
      userCount: 1,
    });
    expect((await member.get("/v1/me")).body.permissions).toEqual(["order:read", "shipment:pack", "shipment:print"]);
    expect((await c.patch(`/v1/roles/${role.id}`, { name: "Viewer" })).body.code).toBe("role.name_taken");
    expect((await c.patch(`/v1/roles/${role.id}`, {})).status).toBe(422);
    expect((await c.patch(`/v1/roles/${role.id}`, { name: "Tim Kemas" })).body.name).toBe("Tim Kemas");
    // its own name in another case is no clash
    expect((await c.patch(`/v1/roles/${role.id}`, { name: "TIM KEMAS" })).status).toBe(200);

    // the audit log names it; a change of permissions shows only what changed
    expect((await audit(c, "role")).map((e) => [e.change, e.label])).toEqual(
      expect.arrayContaining([
        ["created", "Packer Malam"],
        ["updated", "TIM KEMAS"],
      ]),
    );
    const grants = (await audit(c, "role_permission")).filter((e) => e.label === "TIM KEMAS");
    expect(grants.map((e) => e.change)).toEqual(["created", "created", "created"]);

    // deleted once nobody holds it and no open invitation offers it
    const held = await c.delete(`/v1/roles/${role.id}`);
    expect([held.status, held.body.code]).toEqual([409, "role.in_use"]);
    expect(held.body.detail).toBe(
      "Peran ini masih dipakai 1 pengguna. Ganti peran mereka atau batalkan undangannya dulu.",
    );
    const open = await c.post("/v1/invitations", { email: uniqueEmail("calon"), roleId: role.id });
    expect(open.status).toBe(201);
    expect((await c.put(`/v1/users/${m.user.id}/roles`, { roleIds: [await builtIn(c, "Viewer")] })).status).toBe(200);
    expect((await c.delete(`/v1/roles/${role.id}`)).body).toMatchObject({
      code: "role.in_use",
      users: 0,
      invitations: 1,
    });
    expect((await c.delete(`/v1/invitations/${open.body.id}`)).status).toBe(204);
    expect((await c.delete(`/v1/roles/${role.id}`)).status).toBe(204);
    expect((await roles(c)).map((r) => r.id)).not.toContain(role.id);
    // the accepted invitation keeps its row without the role (migration 0024)
    const accepted = await h.system.db.execute<{ role_id: string | null; accepted: boolean }>(
      sql`SELECT role_id, accepted_at IS NOT NULL AS accepted FROM invitation WHERE id = ${invitationId}`,
    );
    expect(accepted.rows[0]).toEqual({ role_id: null, accepted: true });
    expect((await member.get("/v1/me")).body.roles.map((r: { name: string }) => r.name)).toEqual(["Viewer"]);
    expect((await audit(c, "role")).find((e) => e.change === "deleted")).toMatchObject({ label: "TIM KEMAS" });
    // gone, or never there
    expect((await c.patch(`/v1/roles/${role.id}`, { name: "Lagi" })).status).toBe(404);
    expect((await c.delete(`/v1/roles/${role.id}`)).body.code).toBe("role.not_found");
  });

  it("keeps the built-in roles as every business got them", async () => {
    const { c } = await signup(app);
    const viewer = await builtIn(c, "Viewer");
    const patched = await c.patch(`/v1/roles/${viewer}`, { permissions: ["order:read"] });
    expect([patched.status, patched.body.code]).toEqual([409, "role.system"]);
    expect((await c.delete(`/v1/roles/${await builtIn(c, "Owner")}`)).body.code).toBe("role.system");
    expect((await roles(c)).every((r) => r.isSystem)).toBe(true);
  });

  it("on Starter: none made, changed, or handed out, while holders keep theirs and roles can still go", async () => {
    const { c, me } = await signup(app);
    const role = (
      await c.post("/v1/roles", { name: "Admin Stok", permissions: ["inventory:read", "inventory:adjust"] })
    ).body as RoleBody;
    const { member, me: m } = await addMember(c, me.tenant.id, role.id);
    const { me: other } = await addMember(c, me.tenant.id, await builtIn(c, "Viewer"));
    // the trial ends early on Starter (backend doc 8.32)
    await worker.runOutbox(me.tenant.id);
    const down = await c.post("/v1/billing/subscription", { planCode: "starter" });
    expect(down.status, JSON.stringify(down.body)).toBe(200);
    expect((await c.get("/v1/me")).body.plan).toEqual({ code: "starter", name: "Starter", features: [] });

    const refused = await c.post("/v1/roles", { name: "Baru", permissions: ["order:read"] });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: "billing.feature_unavailable",
      feature: "custom_roles",
      plan: "Starter",
      requiredPlan: "Growth",
      detail:
        "Peran kustom tidak termasuk paket Starter. Tersedia mulai paket Growth; naik paket di Langganan & Tagihan.",
    });
    const unavailable = "billing.feature_unavailable";
    expect((await c.patch(`/v1/roles/${role.id}`, { name: "Ubah" })).body.code).toBe(unavailable);
    // not handed to anyone new: invited, or given to someone who does not hold it
    expect((await c.post("/v1/invitations", { email: uniqueEmail("x"), roleId: role.id })).body.code).toBe(unavailable);
    expect((await c.put(`/v1/users/${other.user.id}/roles`, { roleIds: [role.id] })).body.code).toBe(unavailable);
    // who holds it keeps it, also when their other roles change
    const kept = await c.put(`/v1/users/${m.user.id}/roles`, { roleIds: [role.id, await builtIn(c, "Viewer")] });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect((await member.get("/v1/me")).body.permissions).toContain("inventory:adjust");
    // built-in roles are not a plan feature
    expect((await c.put(`/v1/users/${other.user.id}/roles`, { roleIds: [await builtIn(c, "CS")] })).status).toBe(200);
    // and it can still be deleted once nobody holds it
    expect((await c.put(`/v1/users/${m.user.id}/roles`, { roleIds: [await builtIn(c, "Viewer")] })).status).toBe(200);
    expect((await c.delete(`/v1/roles/${role.id}`)).status).toBe(204);
  });

  it("never gives what the giver lacks", async () => {
    const { c, me } = await signup(app);
    const lead = (
      await c.post("/v1/roles", { name: "Kepala Tim", permissions: ["settings:user", "order:read", "shipment:pack"] })
    ).body as RoleBody;
    const stock = (await c.post("/v1/roles", { name: "Stok", permissions: ["inventory:read", "inventory:adjust"] }))
      .body as RoleBody;
    const { member: head } = await addMember(c, me.tenant.id, lead.id);
    // within what they hold
    const own = await head.post("/v1/roles", { name: "Packer", permissions: ["order:read", "shipment:pack"] });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const escalation = "role.privilege_escalation";
    const made = await head.post("/v1/roles", { name: "Kasir", permissions: ["order:read", "finance:read"] });
    expect([made.status, made.body.code]).toEqual([403, escalation]);
    expect(
      (await head.patch(`/v1/roles/${own.body.id}`, { permissions: ["order:read", "settings:billing"] })).body.code,
    ).toBe(escalation);
    // a role that gives what they lack is not theirs to rename, delete, or hand out
    expect((await head.patch(`/v1/roles/${stock.id}`, { name: "Gudang Utama" })).body.code).toBe(escalation);
    // nor narrowed to what they hold: its holders stand above them
    expect((await head.patch(`/v1/roles/${stock.id}`, { permissions: ["order:read"] })).body.code).toBe(escalation);
    expect((await head.delete(`/v1/roles/${stock.id}`)).body.code).toBe(escalation);
    expect((await head.post("/v1/invitations", { email: uniqueEmail("y"), roleId: stock.id })).body.code).toBe(
      escalation,
    );
    // their own role cannot grow either
    expect(
      (
        await head.patch(`/v1/roles/${lead.id}`, {
          permissions: ["settings:user", "order:read", "shipment:pack", "settings:billing"],
        })
      ).body.code,
    ).toBe(escalation);
    expect((await head.delete(`/v1/roles/${own.body.id}`)).status).toBe(204);
  });

  it("lists every role in the full export, built-in and custom, with its holders", async () => {
    const { c, me } = await signup(app);
    const role = (
      await c.post("/v1/roles", { name: "Packer", description: "Shift pagi", permissions: ["shipment:pack"] })
    ).body as RoleBody;
    await addMember(c, me.tenant.id, role.id);
    const sheet = worker.ctx
      .get(ExportRenderService, { strict: false })
      .sheets()
      .find((s) => s.file === "peran.csv")!;
    expect(sheet.columns).toEqual(["nama", "jenis", "deskripsi", "izin", "jumlah_pengguna"]);
    const rows = await withTenantTx(h.worker, userCtx(me.tenant.id), async (tx) => {
      const out: unknown[][] = [];
      const lookups = { storeName: () => null, warehouseCode: () => null, userName: () => null };
      for await (const page of sheet.pages(tx, lookups)) out.push(...page);
      return out;
    });
    expect(rows).toContainEqual(["Packer", "kustom", "Shift pagi", "shipment:pack", 1]);
    expect(rows).toContainEqual(["Owner", "bawaan", expect.anything(), expect.stringContaining("settings:billing"), 1]);
    expect(rows).toHaveLength(7);
  });
});
