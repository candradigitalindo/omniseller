import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import { RateLimitedError } from "../../common/errors/domain-errors";
import { verifyPassword } from "../../common/security/password";
import { RATE_RULES, type RateLimiter } from "../../common/security/rate-limiter";
import { localDate } from "../../common/time-zone";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, RATE_LIMITER } from "../../infra/tokens";
import { AffiliateAccountsService } from "../affiliate-accounts/accounts.service";
import { wrongPassword } from "../auth/auth.errors";
import { CLOSING_PERMISSION } from "../auth/auth.guard";
import { BillingService } from "../billing/billing.service";
import { StoresService } from "../channel/stores.service";
import { InvitationsService } from "../identity/invitations.service";
import { TenantsService } from "../identity/tenants.service";
import { UsersService } from "../identity/users.service";
import { NotificationInboxService } from "../notification/inbox.service";
import { longDate } from "../notification/templates";
import { accountAlreadyClosing, accountNotClosing, businessNameMismatch } from "./closure.errors";
import { CLOSURE_REASON, confirmsName, PURGE_AFTER_DAYS, purgeDate, reminderDue } from "./closure-plan";

export interface ClosureView {
  status: "active" | "suspended" | "closing" | "closed";
  closingAt: Date | null;
  purgeAfter: Date | null;
  closedBy: { id: string; name: string | null } | null;
  /** Marketplaces where OmniSeller may still be authorized after the closure disconnected their stores. */
  revokeLinks: { channel: string; url: string }[];
  purgeAfterDays: number;
}

/**
 * Account closure (PRD 12.1, backend doc 8.36, UI L47 and L54): who manages billing closes the business.
 * At once its marketplace stores are disconnected (data kept), its plan moves to Starter as choosing it
 * would, open invitations go, and everyone else is signed out; for PURGE_AFTER_DAYS it stays read only
 * for who manages billing, who may take the data export or reopen it. Then the retention module's
 * tenant.purge deletes the data. Owns no tables: the tenant row records it (TenantsService).
 */
@Injectable()
export class AccountClosureService {
  private readonly log = logger.forModule("closure");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(AffiliateAccountsService) private readonly affiliateAccounts: AffiliateAccountsService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  get(ctx: RequestContext): Promise<ClosureView> {
    return withTenantTx(this.db, ctx, (tx) => this.viewIn(tx, ctx));
  }

  /**
   * Closes the account. `businessName` must be the business's name and `password` the caller's own; the
   * session `keepToken` came from stays signed in, as do the sessions of everyone who manages billing.
   */
  async close(
    ctx: RequestContext,
    input: { businessName: string; password: string },
    keepToken?: string,
  ): Promise<ClosureView> {
    await this.confirmPassword(ctx, input.password);
    const now = new Date();
    const view = await withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.tenants.closureIn(tx, ctx, true);
      if (c.status !== "active") throw accountAlreadyClosing();
      if (!confirmsName(input.businessName, c.name)) throw businessNameMismatch();
      const purgeAfter = purgeDate(now);
      await this.tenants.markClosingIn(tx, ctx, { closedBy: ctx.actor.id, at: now, purgeAfter });
      // nothing more is pushed to or read from the marketplaces; the stores' history stays until the purge
      const channels = await this.stores.disconnectAllIn(tx, ctx, CLOSURE_REASON);
      await this.affiliateAccounts.disconnectAllIn(tx, ctx);
      await this.billing.closeIn(tx, ctx, now);
      await this.invitations.revokeOpenIn(tx, now);
      const { timezone } = await this.tenants.profileIn(tx, ctx);
      const by = (await this.users.namesIn(tx)).get(ctx.actor.id) ?? "pengguna";
      await this.notify(tx, ctx, {
        severity: "critical",
        reason: "closed",
        title: "Akun bisnis ditutup",
        body: `Akun ${c.name} ditutup oleh ${by}. Seluruh data bisnis akan dihapus pada ${longDate(localDate(timezone, purgeAfter))}. Sampai tanggal itu Anda masih bisa masuk untuk mengunduh ekspor data atau membuka kembali akun.`,
      });
      this.log.info({ tenant_id: ctx.tenantId, stores_channels: channels.length }, "account closing");
      return this.viewIn(tx, ctx);
    });
    // everyone else loses access now; who manages billing keeps theirs, to export or reopen
    const others = await withTenantTx(this.db, ctx, async (tx) => {
      const keep = new Set((await this.users.recipientsIn(tx, CLOSING_PERMISSION)).map((u) => u.id));
      return (await this.users.idsIn(tx)).filter((id) => !keep.has(id));
    });
    await this.users.endSessions(ctx.tenantId, others, keepToken);
    return view;
  }

  /** Reopens a closing account before its purge: members may sign in again; stores stay disconnected. */
  async reopen(ctx: RequestContext): Promise<ClosureView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.tenants.closureIn(tx, ctx, true);
      if (c.status !== "closing") throw accountNotClosing();
      await this.tenants.reopenIn(tx, ctx);
      const by = (await this.users.namesIn(tx)).get(ctx.actor.id) ?? "pengguna";
      await this.notify(tx, ctx, {
        severity: "info",
        reason: "reopened",
        title: "Akun bisnis dibuka kembali",
        body: `Akun ${c.name} dibuka kembali oleh ${by}. Hubungkan lagi toko marketplace di Toko Terhubung, dan pilih paket di Langganan & Tagihan bila perlu.`,
      });
      this.log.info({ tenant_id: ctx.tenantId }, "account reopened");
      return this.viewIn(tx, ctx);
    });
  }

  /**
   * Worker (job account.purge_reminder): once, PURGE_REMINDER_DAYS before the deletion, who manages billing
   * hears that the data goes soon. Nothing when the account was reopened or reminded already.
   */
  async remind(ctx: RequestContext, now = new Date()): Promise<boolean> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.tenants.closureIn(tx, ctx, true);
      if (c.status !== "closing" || !c.purgeAfter || c.purgeRemindedAt || !reminderDue(c.purgeAfter, now)) return false;
      const { timezone } = await this.tenants.profileIn(tx, ctx);
      await this.notify(tx, ctx, {
        severity: "critical",
        reason: "purge_soon",
        title: "Data bisnis segera dihapus",
        body: `Akun ${c.name} sudah ditutup, dan seluruh data bisnisnya dihapus pada ${longDate(localDate(timezone, c.purgeAfter))}. Unduh ekspor data sebelum tanggal itu, atau buka kembali akun bila Anda berubah pikiran.`,
      });
      await this.tenants.markPurgeRemindedIn(tx, ctx, now);
      return true;
    });
  }

  private async viewIn(tx: Tx, ctx: RequestContext): Promise<ClosureView> {
    const c = await this.tenants.closureIn(tx, ctx);
    const closedBy = c.closedBy
      ? { id: c.closedBy, name: (await this.users.namesIn(tx)).get(c.closedBy) ?? null }
      : null;
    const channels = c.status === "closing" ? await this.stores.channelsDisconnectedIn(tx, CLOSURE_REASON) : [];
    return {
      status: c.status,
      closingAt: c.closingAt,
      purgeAfter: c.purgeAfter,
      closedBy,
      revokeLinks: await this.stores.revokeLinks(ctx, channels, tx),
      purgeAfterDays: PURGE_AFTER_DAYS,
    };
  }

  /** The caller's own password again, limited per user like every other re-check (backend doc 8.30). */
  private async confirmPassword(ctx: RequestContext, password: string): Promise<void> {
    const d = await this.limiter.take(`reauth:user:${ctx.actor.id}`, RATE_RULES.reauthPerUser);
    if (!d.allowed) throw new RateLimitedError(d.retryAfterSeconds);
    const u = await withTenantTx(this.db, ctx, (tx) => this.users.twoFactorIn(tx, ctx.actor.id));
    if (!u || !(await verifyPassword(u.passwordHash, password))) throw wrongPassword();
  }

  /** To who manages billing, in the app and by email; nobody can turn these off (L44 "Selalu dikirim"). */
  private async notify(
    tx: Tx,
    ctx: RequestContext,
    n: { severity: "info" | "critical"; reason: string; title: string; body: string },
  ): Promise<void> {
    await this.inbox.notifyScopedIn(
      tx,
      ctx,
      CLOSING_PERMISSION,
      [{}],
      () => ({
        kind: "account.closing",
        severity: n.severity,
        title: n.title,
        body: n.body,
        data: { reason: n.reason },
      }),
      { email: true },
    );
  }
}
