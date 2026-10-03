import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { newId, SYSTEM_ROLES } from "@omniseller/shared";
import { type RequestContext, systemContext } from "../../common/context/request-context";
import { findPgError } from "../../common/errors/problem";
import { hashPassword } from "../../common/security/password";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { IdentityRepository } from "./identity.repository";

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
  ) {}

  /** The business's time zone (Asia/Jakarta unless set): what "today" means in reports. */
  async timezone(ctx: RequestContext): Promise<string> {
    return (await this.profile(ctx)).timezone;
  }

  /** Name and time zone of the caller's business. */
  async profile(ctx: RequestContext): Promise<{ name: string; timezone: string }> {
    const t = await withTenantTx(this.db, ctx, (tx) => this.repo.getTenant(tx, ctx.tenantId));
    return { name: t?.name ?? "", timezone: t?.timezone ?? "Asia/Jakarta" };
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
    return withTenantTx(this.db, systemContext(tenantId), async (tx) => {
      await this.repo.insertTenant(tx, {
        id: tenantId,
        name: input.businessName,
        slug,
        planId: await this.repo.planIdByCode(tx, "starter"),
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
      return { tenantId, userId };
    });
  }
}
