import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import type { NotificationSeverity } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { InboxRepository, type NotificationRow } from "./inbox.repository";

export interface NewNotification {
  userId: string;
  /** Stable machine key, one per kind of alert (`order.sla`); preferences per kind come later (L44). */
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

/**
 * In-app notifications (PRD FR-NTF-01, backend doc 7.8.12): written by other modules inside their
 * transaction, one row per recipient, read and marked read by the recipient only. Email and WhatsApp
 * delivery per preference come with the notification settings (L44).
 */
@Injectable()
export class NotificationInboxService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(InboxRepository) private readonly repo: InboxRepository,
  ) {}

  async notifyIn(tx: Tx, ctx: RequestContext, notifications: NewNotification[]): Promise<void> {
    await this.repo.insertMany(
      tx,
      notifications.map((n) => ({
        id: newId(),
        tenantId: ctx.tenantId,
        userId: n.userId,
        kind: n.kind,
        severity: n.severity,
        title: n.title,
        body: n.body,
        data: n.data,
        channelsSent: { in_app: true },
      })),
    );
  }

  async list(
    ctx: RequestContext,
    opts: { unreadOnly: boolean; before?: string | undefined; limit: number },
  ): Promise<{ items: NotificationRow[]; more: boolean }> {
    const rows = await withTenantTx(this.db, ctx, (tx) =>
      this.repo.list(tx, ctx.actor.id, opts.unreadOnly, opts.before, opts.limit),
    );
    return { items: rows.slice(0, opts.limit), more: rows.length > opts.limit };
  }

  async unreadCount(ctx: RequestContext): Promise<number> {
    return withTenantTx(this.db, ctx, (tx) => this.repo.unreadCount(tx, ctx.actor.id));
  }

  async markRead(ctx: RequestContext, ids: string[] | null): Promise<number> {
    return withTenantTx(this.db, ctx, (tx) => this.repo.markRead(tx, ctx.actor.id, ids));
  }
}
