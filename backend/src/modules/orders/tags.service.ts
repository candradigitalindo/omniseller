import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { actorOf } from "./order-intake.service";
import { tagDuplicate, tagLimit, tagNotFound, tagsUnknown } from "./orders.errors";
import { OrdersRepository } from "./orders.repository";
import { OrdersService } from "./orders.service";
import { type OrderTagRef, type TagRow, TagsRepository } from "./tags.repository";

/** Tags a business keeps; enough for "prioritas", "fragile", "COD", reseller names, campaigns. */
export const MAX_TAGS = 100;

const uniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return (e.code ?? e.cause?.code) === "23505";
};

/**
 * Order tags (PRD FR-ORD-04, UI L03 "Beri tag", backend doc 8.21): the business's list of tags, and
 * tags put on or taken off many orders at once. Orders are filtered by tag in the queue. Each change
 * on an order is kept in its history.
 */
@Injectable()
export class TagsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(TagsRepository) private readonly repo: TagsRepository,
    @Inject(OrdersRepository) private readonly orderRepo: OrdersRepository,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  list(ctx: RequestContext): Promise<(TagRow & { orders: number })[]> {
    return withTenantTx(this.db, ctx, (tx) => this.repo.list(tx));
  }

  /** Tags of these ids that still exist, in the caller's transaction (automatic rules, backend doc 8.37). */
  liveIn(tx: Tx, ids: string[]): Promise<TagRow[]> {
    return this.repo.byIds(tx, [...new Set(ids)]);
  }

  async create(ctx: RequestContext, input: { name: string; color?: string | null | undefined }): Promise<TagRow> {
    return this.named(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        if ((await this.repo.countLive(tx)) >= MAX_TAGS) throw tagLimit(MAX_TAGS);
        if (await this.repo.nameTaken(tx, input.name)) throw tagDuplicate();
        const id = newId();
        await this.repo.insert(tx, { id, tenantId: ctx.tenantId, name: input.name, color: input.color ?? null });
        return (await this.repo.get(tx, id))!;
      }),
    );
  }

  async update(
    ctx: RequestContext,
    id: string,
    patch: { name?: string | undefined; color?: string | null | undefined },
  ): Promise<TagRow> {
    return this.named(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        if (!(await this.repo.get(tx, id, true))) throw tagNotFound();
        if (patch.name !== undefined && (await this.repo.nameTaken(tx, patch.name, id))) throw tagDuplicate();
        await this.repo.update(tx, id, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {}),
        });
        return (await this.repo.get(tx, id))!;
      }),
    );
  }

  /** Takes the tag off every order and deletes it. */
  async remove(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      if (!(await this.repo.get(tx, id, true))) throw tagNotFound();
      await this.repo.softDelete(tx, id);
    });
  }

  /**
   * Puts tags on and takes tags off many orders (L03 bulk bar). Every order must be in the caller's
   * scope and every tag must exist, or nothing changes. Returns each order's tags afterwards.
   */
  async assign(
    ctx: RequestContext,
    input: { orderIds: string[]; add: string[]; remove: string[] },
  ): Promise<{ orderId: string; tags: OrderTagRef[] }[]> {
    const orderIds = [...new Set(input.orderIds)];
    await this.orders.requireVisible(ctx, orderIds);
    return withTenantTx(this.db, ctx, async (tx) => {
      const wanted = [...new Set([...input.add, ...input.remove])];
      const found = new Map((await this.repo.byIds(tx, wanted)).map((t) => [t.id, t]));
      input.add.forEach((t, i) => {
        if (!found.has(t)) throw tagsUnknown(`add.${i}`);
      });
      input.remove.forEach((t, i) => {
        if (!found.has(t)) throw tagsUnknown(`remove.${i}`);
      });
      const removed = await this.repo.remove(tx, orderIds, [...new Set(input.remove)]);
      const added = await this.repo.add(
        tx,
        orderIds.flatMap((orderId) =>
          [...new Set(input.add)].map((tagId) => ({ id: newId(), tenantId: ctx.tenantId, orderId, tagId })),
        ),
      );
      const names = (pairs: { orderId: string; tagId: string }[], orderId: string) =>
        pairs.filter((p) => p.orderId === orderId).map((p) => found.get(p.tagId)!.name);
      const actor = actorOf(ctx);
      await this.orderRepo.insertEvents(
        tx,
        orderIds
          .map((orderId) => ({ orderId, added: names(added, orderId), removed: names(removed, orderId) }))
          .filter((c) => c.added.length > 0 || c.removed.length > 0)
          .map((c) => ({
            id: newId(),
            tenantId: ctx.tenantId,
            orderId: c.orderId,
            type: "tags_changed",
            actorType: actor.type,
            actorId: actor.id,
            payload: { added: c.added, removed: c.removed },
          })),
      );
      const now = await this.repo.ofOrders(tx, orderIds);
      return orderIds.map((orderId) => ({ orderId, tags: now.filter((t) => t.orderId === orderId) }));
    });
  }

  private async named<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (uniqueViolation(err)) throw tagDuplicate();
      throw err;
    }
  }
}
