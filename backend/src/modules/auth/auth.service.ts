import { Inject, Injectable, Optional } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import { type RequestContext, systemContext } from "../../common/context/request-context";
import { RateLimitedError } from "../../common/errors/domain-errors";
import { CHALLENGE_TTL_SECONDS, type LoginChallenges } from "../../common/security/login-challenges";
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from "../../common/security/password";
import { RATE_RULES, type RateLimiter } from "../../common/security/rate-limiter";
import type { SessionStore } from "../../common/security/session-store";
import { hashToken, newSecretToken } from "../../common/security/tokens";
import { ENV } from "../../config/config.module";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, LOGIN_CHALLENGES, OUTBOX, RATE_LIMITER, SESSIONS } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { passwordResetRequested } from "../identity/identity.events";
import { IdentityRepository, PreTenantLookup } from "../identity/identity.repository";
import { UsersService } from "../identity/users.service";
import { EMAIL_SENDER, type EmailSender } from "../notification/email";
import { passwordResetEmail } from "../notification/templates";
import {
  accountLocked,
  invalidCredentials,
  resetTokenInvalid,
  tenantChoiceRequired,
  tenantClosing,
  twoFactorRequired,
} from "./auth.errors";
import { CLOSING_PERMISSION } from "./auth.guard";
import { AuthRepository } from "./auth.repository";

export const RESET_TTL_MINUTES = 60;
const LOGIN_TENANT_STATUSES = new Set(["active", "closing"]);

export interface LoginInput {
  email: string;
  password: string;
  tenant?: string | undefined;
  ip: string;
  userAgent?: string | undefined;
}

/**
 * Login, logout, and password reset (technology doc 5.3, PRD 8.4). Sessions are opaque tokens in
 * Redis; see SessionStore. Owns password_reset_token; user rows are changed through UsersService.
 */
@Injectable()
export class AuthService {
  private readonly log = logger.forModule("auth");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(AuthRepository) private readonly repo: AuthRepository,
    @Inject(IdentityRepository) private readonly identity: IdentityRepository,
    @Inject(PreTenantLookup) private readonly lookup: PreTenantLookup,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SESSIONS) private readonly sessions: SessionStore,
    @Inject(LOGIN_CHALLENGES) private readonly challenges: LoginChallenges,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(ENV) private readonly env: { PUBLIC_WEB_URL?: string },
    @Optional() @Inject(EMAIL_SENDER) private readonly email?: EmailSender,
  ) {}

  async login(input: LoginInput): Promise<{ token: string; tenantId: string; userId: string }> {
    const email = input.email.trim().toLowerCase();
    await this.limit(`login:ip:${input.ip}`, RATE_RULES.loginPerIp);
    await this.limit(`login:email:${email}`, RATE_RULES.loginPerEmail);

    const all = (await this.lookup.loginCandidates(email)).filter(
      (c) => !input.tenant || c.tenant_slug === input.tenant,
    );
    if (all.length === 0) {
      await verifyAgainstDummy(input.password);
      throw invalidCredentials();
    }
    // A locked account is refused before its password is checked; otherwise "locked" versus
    // "wrong password" would tell an attacker that a guess was right.
    const now = new Date();
    const candidates = all.filter((c) => !c.locked_until || c.locked_until <= now);
    if (candidates.length === 0) {
      await verifyAgainstDummy(input.password);
      const until = all.map((c) => c.locked_until!).sort((a, b) => a.getTime() - b.getTime())[0]!;
      throw accountLocked(until);
    }

    const matched: typeof candidates = [];
    for (const c of candidates) {
      if (await verifyPassword(c.password_hash, input.password)) matched.push(c);
    }
    if (matched.length === 0) {
      // Only the accounts the user was trying to reach count the failure.
      for (const c of candidates) await this.users.recordLoginFailure(c.tenant_id, c.user_id);
      throw invalidCredentials();
    }

    const usable = matched.filter((c) => c.user_status === "active" && LOGIN_TENANT_STATUSES.has(c.tenant_status));
    if (usable.length === 0) throw invalidCredentials();
    if (usable.length > 1) {
      throw tenantChoiceRequired(usable.map((c) => ({ slug: c.tenant_slug, name: c.tenant_name })));
    }
    const chosen = usable[0]!;
    // an account closing (backend doc 8.36): only who manages billing signs in, to export or reopen
    if (chosen.tenant_status === "closing") {
      const principal = await this.users.loadPrincipal(chosen.tenant_id, chosen.user_id);
      if (!principal?.permissions.includes(CLOSING_PERMISSION)) throw tenantClosing();
    }

    const rehash = needsRehash(chosen.password_hash) ? await hashPassword(input.password) : undefined;
    if (chosen.totp_enabled) {
      // The password is right, but the account keeps counting failures until a code is right too, so
      // codes cannot be guessed by entering the password again in between (backend doc 8.30).
      const challenge = await this.challenges.create({
        tenantId: chosen.tenant_id,
        userId: chosen.user_id,
        ip: input.ip,
        ...(input.userAgent ? { userAgent: input.userAgent.slice(0, 200) } : {}),
        ...(rehash ? { rehash } : {}),
      });
      this.log.info({ tenant_id: chosen.tenant_id, user_id: chosen.user_id }, "login: second step");
      throw twoFactorRequired(challenge, CHALLENGE_TTL_SECONDS);
    }
    return this.finishLogin({
      tenantId: chosen.tenant_id,
      userId: chosen.user_id,
      ip: input.ip,
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      ...(rehash ? { rehash } : {}),
    });
  }

  /** The last step of every login: resets the failure count, saves a stronger hash, opens the session. */
  async finishLogin(p: {
    tenantId: string;
    userId: string;
    ip: string;
    userAgent?: string;
    rehash?: string;
  }): Promise<{ token: string; tenantId: string; userId: string }> {
    await this.users.recordLoginSuccess(p.tenantId, p.userId, p.rehash);
    const { token } = await this.sessions.create({
      tenantId: p.tenantId,
      userId: p.userId,
      ip: p.ip,
      ...(p.userAgent ? { userAgent: p.userAgent.slice(0, 200) } : {}),
    });
    this.log.info({ tenant_id: p.tenantId, user_id: p.userId }, "login");
    return { token, tenantId: p.tenantId, userId: p.userId };
  }

  async startSession(tenantId: string, userId: string, ip: string, userAgent?: string): Promise<string> {
    const { token } = await this.sessions.create({
      tenantId,
      userId,
      ip,
      ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}),
    });
    return token;
  }

  async logout(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }

  /**
   * Always succeeds from the caller's point of view (no account enumeration). For every active
   * account with this email an event is recorded; the worker creates the token and sends the link.
   */
  async requestPasswordReset(emailInput: string, ip: string): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    await this.limit(`reset:ip:${ip}`, RATE_RULES.resetPerIp);
    const byEmail = await this.limiter.take(`reset:email:${email}`, RATE_RULES.resetPerEmail);
    if (!byEmail.allowed) return; // silently: telling the caller would confirm the address exists
    const candidates = await this.lookup.loginCandidates(email);
    for (const c of candidates) {
      if (c.user_status !== "active" || !LOGIN_TENANT_STATUSES.has(c.tenant_status)) continue;
      const ctx = systemContext(c.tenant_id);
      await withTenantTx(this.db, ctx, (tx) =>
        this.outbox.enqueue(tx, ctx, passwordResetRequested, { userId: c.user_id }, c.user_id),
      );
    }
  }

  /** Worker job: creates the reset token and emails the link. */
  async sendPasswordReset(ctx: RequestContext, userId: string): Promise<"sent" | "skipped"> {
    if (!this.email) throw new Error("AuthService.sendPasswordReset needs an EmailSender (worker process)");
    const token = newSecretToken();
    const prepared = await withTenantTx(this.db, ctx, async (tx) => {
      const user = await this.identity.getUserSecret(tx, userId);
      if (user?.status !== "active") return undefined;
      await this.repo.insertResetToken(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      });
      const tenant = await this.identity.getTenant(tx, ctx.tenantId);
      return { email: user.email, tenantName: tenant?.name ?? "OmniSeller" };
    });
    if (!prepared) return "skipped";
    const url = new URL("/atur-ulang-sandi", this.env.PUBLIC_WEB_URL);
    url.searchParams.set("token", token);
    await this.email.send(
      passwordResetEmail({
        to: prepared.email,
        tenantName: prepared.tenantName,
        url: url.toString(),
        expiresMinutes: RESET_TTL_MINUTES,
      }),
    );
    return "sent";
  }

  /** Sets the new password, invalidates every outstanding link, unlocks, and signs out everywhere. */
  async confirmPasswordReset(token: string, password: string): Promise<void> {
    const found = await this.lookup.passwordReset(hashToken(token));
    if (!found || found.used_at || found.expires_at < new Date()) throw resetTokenInvalid();
    const passwordHash = await hashPassword(password);
    await withTenantTx(this.db, systemContext(found.tenant_id), async (tx) => {
      const row = await this.repo.lockResetToken(tx, found.token_id);
      if (!row || row.usedAt || row.expiresAt < new Date()) throw resetTokenInvalid();
      await this.repo.consumeResetTokens(tx, row.userId);
    });
    await this.users.resetPassword(found.tenant_id, found.user_id, passwordHash);
  }

  private async limit(key: string, rule: (typeof RATE_RULES)[keyof typeof RATE_RULES]): Promise<void> {
    const d = await this.limiter.take(key, rule);
    if (!d.allowed) throw new RateLimitedError(d.retryAfterSeconds);
  }
}
