import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { eq } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { NotFoundError, UnprocessableError } from "../../common/errors/domain-errors";
import type { PlanFeature } from "../../common/plan-features";
import type { DbHandle, Tx } from "../../db/client";
import { notificationPreference } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { TenantsService } from "../identity/tenants.service";

export interface PreferenceKind {
  kind: string;
  label: string;
  /** Email by default: who receives it until they choose (UI L44). */
  emailByDefault: (permissions: ReadonlySet<string>) => boolean;
  /** Always sent, nobody can turn it off (UI L44 "Selalu dikirim"). */
  locked?: boolean;
  /** Who may choose it at all; everyone when absent. The report kinds follow their report's permission. */
  audience?: (permissions: ReadonlySet<string>) => boolean;
  /** A plan feature the kind needs: turning its email on needs the plan, and L44 locks it otherwise. */
  feature?: PlanFeature;
  /** The kind exists only as an email: nothing appears in the app unless the email is on (L44 "Bersama email"). */
  inAppWithEmail?: boolean;
}

const reportKind = (kind: string, label: string, permission: string, feature?: PlanFeature): PreferenceKind => ({
  kind,
  label,
  emailByDefault: () => false,
  audience: (p) => p.has(permission),
  inAppWithEmail: true,
  ...(feature ? { feature } : {}),
});

/** Kinds shown in the user's choices; in-app notifications are always on until L44 adds the rest. */
export const PREFERENCE_KINDS: readonly PreferenceKind[] = [
  {
    kind: "digest.daily",
    label: "Ringkasan operasional harian (email, pukul 07.00)",
    emailByDefault: (p) => p.has("report:read"),
  },
  // scheduled report emails (FR-RPT-05, backend doc 8.20): opt-in, with the workbook attached
  reportKind(
    "report.sales_weekly",
    "Laporan penjualan mingguan (email dengan lampiran Excel, Senin pukul 07.00)",
    "report:read",
  ),
  reportKind(
    "report.sales_monthly",
    "Laporan penjualan bulanan (email dengan lampiran Excel, tanggal 1 pukul 07.00)",
    "report:read",
  ),
  reportKind(
    "report.staff_weekly",
    "Laporan kinerja tim mingguan (email dengan lampiran Excel, Senin pukul 07.00; mulai paket Growth)",
    "settings:user",
    "staff_report",
  ),
  reportKind(
    "report.staff_monthly",
    "Laporan kinerja tim bulanan (email dengan lampiran Excel, tanggal 1 pukul 07.00; mulai paket Growth)",
    "settings:user",
    "staff_report",
  ),
  {
    kind: "store.connection_lost",
    label: "Toko terputus lebih dari 15 menit (dalam aplikasi dan email)",
    emailByDefault: (p) => p.has("settings:store"),
    locked: true,
  },
  {
    kind: "legal.reminder",
    label: "Batas proses NIB dan dokumen legalitas yang akan habis berlaku (dalam aplikasi dan email)",
    emailByDefault: (p) => p.has("settings:billing"),
    locked: true,
  },
  {
    kind: "account.closing",
    label:
      "Penutupan akun bisnis: konfirmasi, pengingat sebelum data dihapus, dan pembukaan kembali (dalam aplikasi dan email)",
    emailByDefault: (p) => p.has("settings:billing"),
    locked: true,
  },
  {
    kind: "billing.reminder",
    label:
      "Langganan dan tagihan: uji coba berakhir, tagihan jatuh tempo, pembayaran, dan kuota pesanan (dalam aplikasi dan email)",
    emailByDefault: (p) => p.has("settings:billing"),
    locked: true,
  },
];

/** Whether L44 shows this kind to the caller: locked kinds to who gets them, audiences to their members. */
const forCaller = (k: PreferenceKind, ctx: RequestContext): boolean =>
  (!k.locked || k.emailByDefault(ctx.permissions)) && (!k.audience || k.audience(ctx.permissions));

const kindOf = (kind: string) => {
  const k = PREFERENCE_KINDS.find((x) => x.kind === kind);
  if (!k) throw new NotFoundError("notification_preference.unknown_kind", "Jenis notifikasi tidak dikenal.");
  return k;
};

/**
 * Notification preferences per user (backend doc 7.8.12, UI L44). A user reads and changes only their
 * own. The daily operational email (FR-NTF-02) is on by default for users who may see sales.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  async list(ctx: RequestContext): Promise<
    {
      kind: string;
      label: string;
      email: boolean;
      emailByDefault: boolean;
      locked: boolean;
      inApp: "always" | "with_email";
      feature: PlanFeature | null;
    }[]
  > {
    const rows = await withTenantTx(this.db, ctx, (tx) =>
      tx.select().from(notificationPreference).where(eq(notificationPreference.userId, ctx.actor.id)),
    );
    // an always-sent kind is shown to the people who get it; a kind with an audience only to them
    return PREFERENCE_KINDS.filter((k) => forCaller(k, ctx)).map((k) => {
      const byDefault = k.emailByDefault(ctx.permissions);
      return {
        kind: k.kind,
        label: k.label,
        email: k.locked ? byDefault : (rows.find((r) => r.kind === k.kind)?.email ?? byDefault),
        emailByDefault: byDefault,
        locked: k.locked === true,
        inApp: k.inAppWithEmail ? "with_email" : "always",
        feature: k.feature ?? null,
      };
    });
  }

  async set(ctx: RequestContext, kind: string, choice: { email: boolean }): Promise<void> {
    const k = kindOf(kind);
    // a kind the caller may not choose is as unknown to them as it is on L44
    if (k.audience && !k.audience(ctx.permissions)) {
      throw new NotFoundError("notification_preference.unknown_kind", "Jenis notifikasi tidak dikenal.");
    }
    if (k.locked) {
      throw new UnprocessableError(
        "notification_preference.locked",
        "Notifikasi ini selalu dikirim dan tidak bisa dimatikan.",
      );
    }
    await withTenantTx(this.db, ctx, async (tx) => {
      // a report the plan lacks cannot be turned on; a choice made while the plan had it stays for a move back up
      if (choice.email && k.feature) await this.tenants.requireFeatureIn(tx, ctx, k.feature);
      await tx
        .insert(notificationPreference)
        .values({ id: newId(), tenantId: ctx.tenantId, userId: ctx.actor.id, kind, email: choice.email })
        .onConflictDoUpdate({
          target: [notificationPreference.tenantId, notificationPreference.userId, notificationPreference.kind],
          set: { email: choice.email },
        });
    });
  }

  /** Users who chose about this kind's email, and what they chose; the rest get the default. */
  async emailChoicesIn(tx: Tx, kind: string): Promise<Map<string, boolean>> {
    kindOf(kind);
    const rows = await tx
      .select({ userId: notificationPreference.userId, email: notificationPreference.email })
      .from(notificationPreference)
      .where(eq(notificationPreference.kind, kind));
    return new Map(rows.map((r) => [r.userId, r.email]));
  }
}
