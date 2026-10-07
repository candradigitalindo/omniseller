import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import QRCode from "qrcode";
import { type RequestContext, systemContext } from "../../common/context/request-context";
import { RateLimitedError } from "../../common/errors/domain-errors";
import type { LoginChallenges } from "../../common/security/login-challenges";
import { verifyPassword } from "../../common/security/password";
import { RATE_RULES, type RateLimiter } from "../../common/security/rate-limiter";
import type { SessionStore } from "../../common/security/session-store";
import {
  newBackupCodes,
  newTotpSecret,
  type TwoFactorKeys,
  totpUri,
  verifyTotp,
} from "../../common/security/two-factor";
import { ENV } from "../../config/config.module";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, LOGIN_CHALLENGES, RATE_LIMITER, SESSIONS } from "../../infra/tokens";
import { twoFactorNotEnabled, userNotFound } from "../identity/identity.errors";
import { UsersService } from "../identity/users.service";
import {
  accountLocked,
  codeWrong,
  twoFactorAlreadyEnabled,
  twoFactorExpired,
  twoFactorInvalid,
  twoFactorNotStarted,
  wrongPassword,
} from "./auth.errors";
import { AuthService } from "./auth.service";

/** The api's keys for two-step verification, from TOTP_ENCRYPTION_KEY (api process only). */
export const TWO_FACTOR_KEYS = Symbol("TWO_FACTOR_KEYS");

type TwoFactorRow = NonNullable<Awaited<ReturnType<UsersService["twoFactorIn"]>>>;
interface Factor {
  code?: string | undefined;
  backupCode?: string | undefined;
}

/**
 * Verification in two steps (PRD FR-USR-05, technology doc 5.3, backend doc 8.30): turning it on with an
 * authenticator app, backup codes, turning it off, and the second step of a login. Api process only:
 * it holds the key the TOTP secrets are sealed with. The user row belongs to identity (`UsersService`).
 */
@Injectable()
export class TwoFactorService {
  private readonly log = logger.forModule("auth");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(LOGIN_CHALLENGES) private readonly challenges: LoginChallenges,
    @Inject(SESSIONS) private readonly sessions: SessionStore,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(TWO_FACTOR_KEYS) private readonly keys: TwoFactorKeys,
    @Inject(ENV) private readonly env: { TOTP_ISSUER: string },
  ) {}

  /**
   * POST /v1/auth/login/two-factor: a code from the app or a backup code for the challenge the password
   * step gave. A wrong code counts as a failed login (5 in a row lock the account) and as one of the
   * challenge's 5 tries; a code works once.
   */
  async completeLogin(input: Factor & { challenge: string; ip: string }) {
    await this.limit(`login2fa:ip:${input.ip}`, RATE_RULES.twoFactorPerIp);
    const c = await this.challenges.get(input.challenge);
    if (!c) throw twoFactorExpired();
    const outcome = await withTenantTx(
      this.db,
      systemContext(c.tenantId),
      async (tx): Promise<{ kind: "gone" } | { kind: "locked"; until: Date } | { kind: "checked"; ok: boolean }> => {
        const u = await this.users.twoFactorIn(tx, c.userId, true);
        // turned off or disabled since the password step: start again
        if (u?.status !== "active" || !u.totpEnabled || !u.totpSecretEnc) return { kind: "gone" };
        if (u.lockedUntil && u.lockedUntil > new Date()) return { kind: "locked", until: u.lockedUntil };
        return { kind: "checked", ok: await this.useFactor(tx, c.tenantId, u, input) };
      },
    );
    if (outcome.kind === "gone") {
      await this.challenges.consume(input.challenge);
      throw twoFactorExpired();
    }
    if (outcome.kind === "locked") {
      await this.challenges.consume(input.challenge);
      throw accountLocked(outcome.until);
    }
    if (!outcome.ok) {
      const { lockedUntil } = await this.users.recordLoginFailure(c.tenantId, c.userId);
      if (lockedUntil) {
        await this.challenges.consume(input.challenge);
        throw accountLocked(lockedUntil);
      }
      if (!(await this.challenges.miss(input.challenge))) throw twoFactorExpired();
      throw twoFactorInvalid();
    }
    // two requests with good codes: only the one that ends the challenge signs in
    if (!(await this.challenges.consume(input.challenge))) throw twoFactorExpired();
    if (input.backupCode !== undefined) {
      this.log.info({ tenant_id: c.tenantId, user_id: c.userId }, "login with a backup code");
    }
    return this.auth.finishLogin({
      tenantId: c.tenantId,
      userId: c.userId,
      ip: input.ip,
      ...(c.userAgent ? { userAgent: c.userAgent } : {}),
      ...(c.rehash ? { rehash: c.rehash } : {}),
    });
  }

  async status(ctx: RequestContext) {
    return withTenantTx(this.db, ctx, async (tx) => {
      const u = await this.users.twoFactorIn(tx, ctx.actor.id);
      if (!u) throw userNotFound();
      const roles = await this.users.rolesIn(tx, ctx.actor.id);
      return {
        enabled: u.totpEnabled,
        enabledAt: u.totpEnabledAt,
        backupCodesLeft: u.totpEnabled ? u.backupCodes.length : 0,
        recommended: roles.some((r) => r.name === "Owner" || r.name === "Admin"),
      };
    });
  }

  /**
   * First step of turning it on, after the password: a new secret to scan. It is kept sealed but counts
   * only once a code made from it is confirmed (`enable`); starting again replaces it.
   */
  async setup(ctx: RequestContext, password: string): Promise<{ secret: string; uri: string; qrSvg: string }> {
    await this.confirmPassword(ctx, password);
    const secret = newTotpSecret();
    const email = await withTenantTx(this.db, ctx, async (tx) => {
      const u = await this.users.twoFactorIn(tx, ctx.actor.id, true);
      if (!u) throw userNotFound();
      if (u.totpEnabled) throw twoFactorAlreadyEnabled();
      await this.users.setTwoFactorIn(tx, u.id, {
        totpSecretEnc: this.keys.seal(ctx.tenantId, u.id, secret),
        totpLastStep: null,
      });
      return u.email;
    });
    const uri = totpUri(this.env.TOTP_ISSUER, email, secret);
    const qrSvg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
    return { secret, uri, qrSvg };
  }

  /**
   * Second step: a code from the app proves it was set up. Returns the 10 backup codes, shown once. Every
   * other session of the user signed in with the password alone, so they end; this one stays.
   */
  async enable(ctx: RequestContext, code: string, keepSessionToken?: string): Promise<{ backupCodes: string[] }> {
    const backupCodes = newBackupCodes();
    await withTenantTx(this.db, ctx, async (tx) => {
      const u = await this.users.twoFactorIn(tx, ctx.actor.id, true);
      if (!u) throw userNotFound();
      if (u.totpEnabled) throw twoFactorAlreadyEnabled();
      if (!u.totpSecretEnc) throw twoFactorNotStarted();
      const step = await verifyTotp(this.keys.open(ctx.tenantId, u.id, u.totpSecretEnc), code);
      if (step === null) throw codeWrong("code");
      await this.users.setTwoFactorIn(tx, u.id, {
        totpEnabled: true,
        totpEnabledAt: new Date(),
        totpLastStep: step,
        totpBackupCodes: backupCodes.map((b) => this.keys.hashBackupCode(u.id, b)),
      });
    });
    await this.sessions.revokeAll(ctx.tenantId, ctx.actor.id, keepSessionToken);
    return { backupCodes };
  }

  /** New backup codes after the password; the old ones stop working. */
  async regenerateBackupCodes(ctx: RequestContext, password: string): Promise<{ backupCodes: string[] }> {
    await this.confirmPassword(ctx, password);
    const backupCodes = newBackupCodes();
    await withTenantTx(this.db, ctx, async (tx) => {
      const u = await this.users.twoFactorIn(tx, ctx.actor.id, true);
      if (!u?.totpEnabled) throw twoFactorNotEnabled();
      await this.users.setTwoFactorIn(tx, u.id, {
        totpBackupCodes: backupCodes.map((b) => this.keys.hashBackupCode(u.id, b)),
      });
    });
    return { backupCodes };
  }

  /** Turning it off takes the password and a code: a session left open on a shared computer is not enough. */
  async disable(ctx: RequestContext, password: string, factor: Factor): Promise<void> {
    await this.confirmPassword(ctx, password);
    await withTenantTx(this.db, ctx, async (tx) => {
      const u = await this.users.twoFactorIn(tx, ctx.actor.id, true);
      if (!u?.totpEnabled || !u.totpSecretEnc) throw twoFactorNotEnabled();
      if (!(await this.useFactor(tx, ctx.tenantId, u, factor))) {
        throw codeWrong(factor.code !== undefined ? "code" : "backupCode");
      }
      await this.users.setTwoFactorIn(tx, u.id, {
        totpEnabled: false,
        totpEnabledAt: null,
        totpSecretEnc: null,
        totpLastStep: null,
        totpBackupCodes: [],
      });
    });
  }

  /** Checks and uses up a code: an app code moves the last used step, a backup code is removed. */
  private async useFactor(tx: Tx, tenantId: string, u: TwoFactorRow, f: Factor): Promise<boolean> {
    if (f.code !== undefined) {
      if (!u.totpSecretEnc) return false;
      const secret = this.keys.open(tenantId, u.id, u.totpSecretEnc);
      const step = await verifyTotp(secret, f.code, { afterStep: u.totpLastStep });
      if (step === null) return false;
      await this.users.setTwoFactorIn(tx, u.id, { totpLastStep: step });
      return true;
    }
    if (f.backupCode === undefined) return false;
    return this.users.useBackupCodeIn(tx, u.id, this.keys.hashBackupCode(u.id, f.backupCode));
  }

  /** The password again, for changes to how one signs in; limited per user so a stolen session cannot guess it. */
  private async confirmPassword(ctx: RequestContext, password: string): Promise<void> {
    await this.limit(`reauth:user:${ctx.actor.id}`, RATE_RULES.reauthPerUser);
    const u = await withTenantTx(this.db, ctx, (tx) => this.users.twoFactorIn(tx, ctx.actor.id));
    if (!u || !(await verifyPassword(u.passwordHash, password))) throw wrongPassword();
  }

  private async limit(key: string, rule: (typeof RATE_RULES)[keyof typeof RATE_RULES]): Promise<void> {
    const d = await this.limiter.take(key, rule);
    if (!d.allowed) throw new RateLimitedError(d.retryAfterSeconds);
  }
}
