import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { newId, SYSTEM_ROLES } from "@omniseller/shared";
import { type RequestContext, systemContext } from "../../common/context/request-context";
import { findPgError } from "../../common/errors/problem";
import { hashPassword } from "../../common/security/password";
import type { DbHandle, Tx } from "../../db/client";
import type { PlanLimits } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { tenantCreated } from "./identity.events";
import { IdentityRepository } from "./identity.repository";

/** A plan as the seeds define it (PRD 14; backend doc 8.32). */
export interface PlanView {
  id: string;
  code: string;
  name: string;
  limits: PlanLimits;
  features: string[];
  /** Rupiah per month; 0 for the free plan. */
  priceMonthly: number;
  active: boolean;
}

/** The plan a new business starts on: its 14-day trial (PRD 15.1); billing records the trial itself. */
export const SIGNUP_PLAN = "growth";

const ROLE_DESCRIPTIONS: Record<string, string> = {
  Owner: "Semua akses, termasuk tagihan dan pengelolaan tim",
  Admin: "Produk, stok, pesanan, pengaturan operasional, laporan",
  Gudang: "Ambil, kemas, scan, cetak label, dan stock opname di gudang yang ditugaskan",
  CS: "Chat, ulasan, retur, dan catatan pesanan; tidak bisa mengubah harga dan stok",
  Finance: "Rekonsiliasi, laporan keuangan, ekspor; baca saja untuk modul lain",
  Viewer: "Hanya melihat dasbor dan laporan",
};

export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return base.length >= 3 ? base : `toko-${base}`.replace(/-+$/, "");
}

export interface SignupInput {
  businessName: string;
  name: string;
  email: string;
  password: string;
}

/**
 * Tenant creation (PRD 7.1 step 1): tenant, the six built-in roles copied into the tenant
 * (backend doc 7.8.1), the Owner user, and a default warehouse so a first store can be mapped to it
 * right away (PRD FR-WHS-03).
 */
@Injectable()
export class TenantsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(IdentityRepository) private readonly repo: IdentityRepository,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  /** The business's time zone (Asia/Jakarta unless set): what "today" means in reports. */
  async timezone(ctx: RequestContext): Promise<string> {
    return (await this.profile(ctx)).timezone;
  }

  /** Name, time zone, and age of the caller's business. */
  async profile(ctx: RequestContext): Promise<{ name: string; timezone: string; createdAt: Date }> {
    return withTenantTx(this.db, ctx, (tx) => this.profileIn(tx, ctx));
  }

  async profileIn(tx: Tx, ctx: RequestContext): Promise<{ name: string; timezone: string; createdAt: Date }> {
    const t = await this.repo.getTenant(tx, ctx.tenantId);
    return { name: t?.name ?? "", timezone: t?.timezone ?? "Asia/Jakarta", createdAt: t?.createdAt ?? new Date(0) };
  }

  // ---- plans (backend doc 8.32): billing decides, `tenant.plan_id` records the plan in force ----

  /** The plan in force for the caller's business. */
  async planIn(tx: Tx, ctx: RequestContext): Promise<PlanView> {
    const t = await this.repo.getTenant(tx, ctx.tenantId);
    const plan = (await this.listPlansIn(tx)).find((p) => p.id === t?.planId);
    if (!plan) throw new Error(`tenant ${ctx.tenantId} has no plan`);
    return plan;
  }

  /** Every plan, cheapest first; `active` false for plans no longer offered. */
  async listPlansIn(tx: Tx): Promise<PlanView[]> {
    return (await this.repo.listPlans(tx)).map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      limits: p.limits,
      features: p.features,
      priceMonthly: p.priceMonthly,
      active: p.active,
    }));
  }

  /** Plan names by id, for the audit log and the export. */
  async planNamesIn(tx: Tx): Promise<Map<string, string>> {
    return new Map((await this.repo.listPlans(tx)).map((p) => [p.id, p.name]));
  }

  /** Moves the business to the plan in force (trial, payment, lapse); billing's call only. */
  async setPlanIn(tx: Tx, ctx: RequestContext, planId: string): Promise<void> {
    await this.repo.setTenantPlan(tx, ctx.tenantId, planId);
  }

  /** Renames the business or moves it to another time zone, in the caller's transaction (L47). */
  async updateProfileIn(tx: Tx, ctx: RequestContext, patch: { name?: string; timezone?: string }): Promise<void> {
    await this.repo.updateTenant(tx, ctx.tenantId, patch);
  }

  async signup(input: SignupInput): Promise<{ tenantId: string; userId: string }> {
    const passwordHash = await hashPassword(input.password); // slow; never inside a transaction
    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = `${slugify(input.businessName)}-${randomBytes(3).toString("hex").slice(0, 4)}`;
      try {
        return await this.createTenant(input, slug, passwordHash);
      } catch (err) {
        if (findPgError(err)?.constraint === "tenant_slug_key" && attempt < 2) continue;
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  private async createTenant(input: SignupInput, slug: string, passwordHash: string) {
    const tenantId = newId();
    const userId = newId();
    const ctx = systemContext(tenantId);
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.insertTenant(tx, {
        id: tenantId,
        name: input.businessName,
        slug,
        planId: await this.repo.planIdByCode(tx, SIGNUP_PLAN),
      });
      const permissionIds = await this.repo.permissionIdsByCode(tx);
      let ownerRoleId = "";
      for (const [name, codes] of Object.entries(SYSTEM_ROLES)) {
        const roleId = newId();
        if (name === "Owner") ownerRoleId = roleId;
        await this.repo.insertRole(
          tx,
          { id: roleId, tenantId, name, isSystem: true, description: ROLE_DESCRIPTIONS[name] ?? null },
          codes.map((code) => {
            const permissionId = permissionIds.get(code);
            if (!permissionId) throw new Error(`permission ${code} missing from seed`);
            return { id: newId(), tenantId, roleId, permissionId };
          }),
        );
      }
      await this.repo.insertUser(tx, {
        id: userId,
        tenantId,
        email: input.email,
        name: input.name,
        passwordHash,
        status: "active",
      });
      await this.repo.setUserRoles(tx, tenantId, userId, [ownerRoleId], newId);
      await this.repo.insertWarehouse(tx, {
        id: newId(),
        tenantId,
        code: "UTAMA",
        name: "Gudang Utama",
        address: {},
        isDefault: true,
      });
      // billing writes the trial row (job billing.trial_start) and counts the days from here
      await this.outbox.enqueue(tx, ctx, tenantCreated, {}, tenantId);
      return { tenantId, userId };
    });
  }
}
