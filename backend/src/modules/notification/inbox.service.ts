import { Inject, Injectable } from "@nestjs/common";
import { newId, type Permission } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import type { NotificationSeverity } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { UsersService } from "../identity/users.service";
import { InboxRepository, type NotificationRow } from "./inbox.repository";

/** What a notification is about, for the recipient's store and warehouse scope; undefined = not limited. */
export interface ScopedItem {
  storeId?: string | null;
  warehouseId?: string | null;
}

type Recipient = { storeScope: string[] | null; warehouseScope: string[] | null };

/** Same rule as the order list: a scoped user sees an item only when its store and warehouse are in scope. */
export function inScope(r: Recipient, item: ScopedItem): boolean {
  const store =
    item.storeId === undefined ||
    r.storeScope === null ||
    (item.storeId !== null && r.storeScope.includes(item.storeId));
  const warehouse =
    item.warehouseId === undefined ||
    r.warehouseScope === null ||
    (item.warehouseId !== null && r.warehouseScope.includes(item.warehouseId));
  return store && warehouse;
}

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
    @Inject(UsersService) private readonly users: UsersService,
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

  /**
   * One notification per active user holding `permission`, built from the items in that user's store
   * and warehouse scope; users who see none of the items get nothing. Returns the notifications written.
   */
  async notifyScopedIn<T extends ScopedItem>(
    tx: Tx,
    ctx: RequestContext,
    permission: Permission,
    items: T[],
    build: (theirs: T[]) => Omit<NewNotification, "userId"> | null,
  ): Promise<number> {
    if (items.length === 0) return 0;
    const notes: NewNotification[] = [];
    for (const r of await this.users.recipientsIn(tx, permission)) {
      const theirs = items.filter((i) => inScope(r, i));
      if (theirs.length === 0) continue;
      const n = build(theirs);
      if (n) notes.push({ ...n, userId: r.id });
    }
    await this.notifyIn(tx, ctx, notes);
    return notes.length;
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
