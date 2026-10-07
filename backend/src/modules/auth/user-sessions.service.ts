import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { describeUserAgent } from "../../common/http/user-agent";
import { type SessionStore, sessionIdOf } from "../../common/security/session-store";
import { hashToken } from "../../common/security/tokens";
import { SESSIONS } from "../../infra/tokens";
import { sessionIsCurrent, sessionNotFound } from "./auth.errors";

/**
 * "Perangkat yang masuk" (PRD FR-USR-06, backend doc 8.30): the caller's own web sessions, and signing
 * out of one or of every other device. An Owner signs a member out through `UsersService.revokeSessions`.
 */
@Injectable()
export class UserSessionsService {
  constructor(@Inject(SESSIONS) private readonly sessions: SessionStore) {}

  /** This device first, then the most recently used. */
  async list(ctx: RequestContext, currentToken?: string) {
    const current = currentToken ? hashToken(currentToken) : undefined;
    const rows = await this.sessions.list(ctx.tenantId, ctx.actor.id);
    return rows
      .map((s) => ({
        id: s.id,
        current: s.hash === current,
        createdAt: new Date(s.createdAt),
        lastSeenAt: new Date(s.lastSeenAt),
        ip: s.ip ?? null,
        ...describeUserAgent(s.userAgent),
      }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  }

  /** Signs one other device out. This device signs out with POST /v1/auth/logout. */
  async revoke(ctx: RequestContext, id: string, currentToken?: string): Promise<void> {
    if (currentToken && sessionIdOf(hashToken(currentToken)) === id) throw sessionIsCurrent();
    if (!(await this.sessions.revokeById(ctx.tenantId, ctx.actor.id, id))) throw sessionNotFound();
  }

  revokeOthers(ctx: RequestContext, currentToken?: string): Promise<number> {
    return this.sessions.revokeAll(ctx.tenantId, ctx.actor.id, currentToken);
  }
}
