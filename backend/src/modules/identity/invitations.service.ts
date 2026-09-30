import { Inject, Injectable, Optional } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import { type RequestContext, systemContext } from "../../common/context/request-context";
import { decodeCursor, page } from "../../common/http/pagination";
import { hashPassword } from "../../common/security/password";
import { hashToken, newSecretToken } from "../../common/security/tokens";
import { ENV } from "../../config/config.module";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { EMAIL_SENDER, type EmailSender } from "../notification/email";
import { invitationEmail } from "../notification/templates";
import {
  emailTaken,
  invitationAlreadyOpen,
  invitationInvalid,
  invitationNotFound,
  privilegeEscalation,
  roleNotFound,
} from "./identity.errors";
import { invitationSendRequested } from "./identity.events";
import { IdentityRepository, PreTenantLookup } from "./identity.repository";

/** Invitation links are valid for 72 hours (technology doc 5.3). */
export const INVITATION_TTL_HOURS = 72;

export interface InvitationView {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
  expiresAt: Date;
  sentAt: Date | null;
  createdAt: Date;
  status: "pending" | "sent" | "expired";
}

type InvitationRow = NonNullable<Awaited<ReturnType<IdentityRepository["getInvitation"]>>>;

function view(row: InvitationRow, now = new Date()): InvitationView {
  const status = row.sentAt === null ? "pending" : row.expiresAt < now ? "expired" : "sent";
  return {
    id: row.id,
    email: row.email,
    roleId: row.roleId,
    roleName: row.roleName,
    expiresAt: row.expiresAt,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    status,
  };
}

/**
 * Team invitations (PRD FR-USR-03). The request only records the invitation and an outbox event;
 * the worker job issues the token and sends the email (migration 0002 explains why).
 */
@Injectable()
export class InvitationsService {
  private readonly log = logger.forModule("identity");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(IdentityRepository) private readonly repo: IdentityRepository,
    @Inject(PreTenantLookup) private readonly lookup: PreTenantLookup,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(ENV) private readonly env: { PUBLIC_WEB_URL?: string },
    @Optional() @Inject(EMAIL_SENDER) private readonly email?: EmailSender,
  ) {}

  async invite(ctx: RequestContext, input: { email: string; roleId: string }): Promise<InvitationView> {
    const email = input.email.trim().toLowerCase();
    return withTenantTx(this.db, ctx, async (tx) => {
      const [targetRole] = await this.repo.listRoles(tx, [input.roleId]);
      if (!targetRole) throw roleNotFound();
      if (targetRole.permissions.some((p) => !ctx.permissions.has(p))) throw privilegeEscalation();
      if (await this.repo.userIdByEmail(tx, email)) throw emailTaken();
      if (await this.repo.openInvitationByEmail(tx, email)) throw invitationAlreadyOpen();
      const id = newId();
      await this.repo.insertInvitation(tx, {
        id,
        tenantId: ctx.tenantId,
        email,
        roleId: input.roleId,
        invitedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
        expiresAt: new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000),
      });
      await this.outbox.enqueue(tx, ctx, invitationSendRequested, { invitationId: id }, id);
      return view((await this.repo.getInvitation(tx, id))!);
    });
  }

  async resend(ctx: RequestContext, id: string): Promise<InvitationView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.getInvitation(tx, id, true);
      if (!row || row.acceptedAt || row.revokedAt) throw invitationNotFound();
      await this.outbox.enqueue(tx, ctx, invitationSendRequested, { invitationId: id }, id);
      return view(row);
    });
  }

  async revoke(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.getInvitation(tx, id, true);
      if (!row || row.acceptedAt || row.revokedAt) throw invitationNotFound();
      await this.repo.updateInvitation(tx, id, { revokedAt: new Date(), tokenHash: null });
    });
  }

  async list(ctx: RequestContext, cursor: string | undefined, limit: number) {
    const rows = await withTenantTx(this.db, ctx, (tx) =>
      this.repo.listOpenInvitations(tx, decodeCursor(cursor), limit),
    );
    const p = page(rows, limit);
    return { items: p.items.map((r) => view(r)), next_cursor: p.next_cursor };
  }

  /**
   * Worker job: issue a fresh token (replacing any earlier one), extend the expiry, then email the link.
   * The token is committed before sending; a failed send retries with yet another token.
   */
  async send(ctx: RequestContext, invitationId: string): Promise<"sent" | "skipped"> {
    if (!this.email) throw new Error("InvitationsService.send needs an EmailSender (worker process)");
    const token = newSecretToken();
    const prepared = await withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.getInvitation(tx, invitationId, true);
      if (!row || row.acceptedAt || row.revokedAt) return undefined;
      const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000);
      await this.repo.updateInvitation(tx, invitationId, {
        tokenHash: hashToken(token),
        expiresAt,
        sentAt: new Date(),
      });
      const tenant = await this.repo.getTenant(tx, ctx.tenantId);
      const inviter = row.invitedBy ? await this.repo.getUserSecret(tx, row.invitedBy) : undefined;
      return { row, tenantName: tenant?.name ?? "OmniSeller", inviterName: inviter?.name ?? null };
    });
    if (!prepared) {
      this.log.info({ invitation_id: invitationId }, "invitation no longer open; not sent");
      return "skipped";
    }
    const url = new URL("/undangan", this.env.PUBLIC_WEB_URL);
    url.searchParams.set("token", token);
    await this.email.send(
      invitationEmail({
        to: prepared.row.email,
        tenantName: prepared.tenantName,
        roleName: prepared.row.roleName,
        inviterName: prepared.inviterName,
        url: url.toString(),
        expiresHours: INVITATION_TTL_HOURS,
      }),
    );
    return "sent";
  }

  /** Public: what the accept page shows before the user sets a password. */
  async inspect(token: string) {
    const found = await this.resolveOpen(token);
    return withTenantTx(this.db, systemContext(found.tenant_id), async (tx) => {
      const row = await this.repo.getInvitation(tx, found.invitation_id);
      const tenant = await this.repo.getTenant(tx, found.tenant_id);
      if (!row || !tenant) throw invitationInvalid();
      return { tenantName: tenant.name, email: row.email, roleName: row.roleName, expiresAt: row.expiresAt };
    });
  }

  /** Public: creates the user from the invitation. Returns ids so the caller can start a session. */
  async accept(
    token: string,
    input: { name: string; password: string },
  ): Promise<{ tenantId: string; userId: string }> {
    const found = await this.resolveOpen(token);
    const passwordHash = await hashPassword(input.password);
    const userId = newId();
    await withTenantTx(this.db, systemContext(found.tenant_id), async (tx) => {
      const row = await this.repo.getInvitation(tx, found.invitation_id, true);
      if (!row || row.acceptedAt || row.revokedAt || row.expiresAt < new Date()) throw invitationInvalid();
      if (await this.repo.userIdByEmail(tx, row.email)) throw emailTaken();
      await this.repo.insertUser(tx, {
        id: userId,
        tenantId: found.tenant_id,
        email: row.email,
        name: input.name,
        passwordHash,
        status: "active",
      });
      await this.repo.setUserRoles(tx, found.tenant_id, userId, [row.roleId], newId);
      await this.repo.updateInvitation(tx, row.id, { acceptedAt: new Date(), acceptedUserId: userId, tokenHash: null });
    });
    return { tenantId: found.tenant_id, userId };
  }

  private async resolveOpen(token: string) {
    const found = await this.lookup.invitation(hashToken(token));
    if (!found || found.accepted_at || found.revoked_at || found.expires_at < new Date()) throw invitationInvalid();
    return found;
  }
}
