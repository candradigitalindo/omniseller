import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { eq } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { NotFoundError, UnprocessableError } from "../../common/errors/domain-errors";
import type { DbHandle, Tx } from "../../db/client";
import { notificationPreference } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";

export interface PreferenceKind {
  kind: string;
  label: string;
  /** Email by default: who receives it until they choose (UI L44). */
  emailByDefault: (permissions: ReadonlySet<string>) => boolean;
  /** Always sent, nobody can turn it off (UI L44 "Selalu dikirim"). */
  locked?: boolean;
}

/** Kinds shown in the user's choices; in-app notifications are always on until L44 adds the rest. */
export const PREFERENCE_KINDS: readonly PreferenceKind[] = [
  {
    kind: "digest.daily",
    label: "Ringkasan operasional harian (email, pukul 07.00)",
    emailByDefault: (p) => p.has("report:read"),
  },
  {
    kind: "store.connection_lost",
    label: "Toko terputus lebih dari 15 menit (dalam aplikasi dan email)",
    emailByDefault: (p) => p.has("settings:store"),
    locked: true,
  },
];

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
  constructor(@Inject(DB_TENANT) private readonly db: DbHandle) {}

  async list(
    ctx: RequestContext,
  ): Promise<{ kind: string; label: string; email: boolean; emailByDefault: boolean; locked: boolean }[]> {
    const rows = await withTenantTx(this.db, ctx, (tx) =>
      tx.select().from(notificationPreference).where(eq(notificationPreference.userId, ctx.actor.id)),
    );
    // an always-sent kind is shown to the people who get it
    return PREFERENCE_KINDS.filter((k) => !k.locked || k.emailByDefault(ctx.permissions)).map((k) => {
      const byDefault = k.emailByDefault(ctx.permissions);
      return {
        kind: k.kind,
        label: k.label,
        email: k.locked ? byDefault : (rows.find((r) => r.kind === k.kind)?.email ?? byDefault),
        emailByDefault: byDefault,
        locked: k.locked === true,
      };
    });
  }

  async set(ctx: RequestContext, kind: string, choice: { email: boolean }): Promise<void> {
    if (kindOf(kind).locked) {
      throw new UnprocessableError(
        "notification_preference.locked",
        "Notifikasi ini selalu dikirim dan tidak bisa dimatikan.",
      );
    }
    await withTenantTx(this.db, ctx, (tx) =>
      tx
        .insert(notificationPreference)
        .values({ id: newId(), tenantId: ctx.tenantId, userId: ctx.actor.id, kind, email: choice.email })
        .onConflictDoUpdate({
          target: [notificationPreference.tenantId, notificationPreference.userId, notificationPreference.kind],
          set: { email: choice.email },
        }),
    );
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
