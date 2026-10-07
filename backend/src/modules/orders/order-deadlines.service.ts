import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { CourierCalendarService } from "../campaign/courier-calendar.service";
import { type CourierCalendarInput, internalDeadline } from "../campaign/cutoff-plan";
import { TO_SHIP_STATUSES } from "./order-plan";
import { OrdersRepository } from "./orders.repository";

/** Orders refreshed per transaction when the courier calendar changed. */
const BATCH = 500;

/**
 * Internal deadlines of orders to ship (PRD FR-CMP-05, 06; backend doc 8.31): `order.internal_ship_by_at`,
 * the first courier cut-off an order can still make, from the courier calendar of the campaign module.
 * Kept up to date for an order whenever it settles (intake, manual orders, warehouse moves), and for every
 * order to ship when the calendar changes. An order that left the queue keeps its last deadline, so it can
 * be told later whether it made it.
 */
@Injectable()
export class OrderDeadlinesService {
  /** One calendar per transaction: a page of orders coming in reads it once. */
  private readonly calendars = new WeakMap<Tx, Promise<CourierCalendarInput | null>>();

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersRepository) private readonly repo: OrdersRepository,
    @Inject(CourierCalendarService) private readonly calendar: CourierCalendarService,
  ) {}

  /** In the caller's transaction. Returns the deadlines that changed. */
  async refreshIn(tx: Tx, ctx: RequestContext, orderIds: string[]): Promise<Map<string, Date | null>> {
    const changed = new Map<string, Date | null>();
    const rows = (await this.repo.deadlineInputs(tx, orderIds)).filter((r) => TO_SHIP_STATUSES.has(r.status));
    if (rows.length === 0) return changed;
    const calendar = await this.calendarIn(tx, ctx);
    for (const r of rows) {
      const next = calendar
        ? (internalDeadline(calendar, {
            warehouseId: r.warehouseId,
            courier: r.shippingProvider,
            readyAt: r.paidAt ?? r.orderedAt,
          })?.at ?? null)
        : null;
      if ((next?.getTime() ?? null) === (r.internalShipByAt?.getTime() ?? null)) continue;
      await this.repo.update(tx, r.id, { internalShipByAt: next });
      changed.set(r.id, next);
    }
    return changed;
  }

  /** Job `order.internal_deadlines`: every order to ship, a batch per transaction. Returns how many changed. */
  async refreshAll(ctx: RequestContext): Promise<number> {
    let after: string | undefined;
    let total = 0;
    for (;;) {
      const page = await withTenantTx(this.db, ctx, async (tx) => {
        const ids = await this.repo.toShipIds(tx, after, BATCH);
        return { ids, changed: ids.length > 0 ? (await this.refreshIn(tx, ctx, ids)).size : 0 };
      });
      total += page.changed;
      if (page.ids.length < BATCH) return total;
      after = page.ids.at(-1);
    }
  }

  private calendarIn(tx: Tx, ctx: RequestContext): Promise<CourierCalendarInput | null> {
    let calendar = this.calendars.get(tx);
    if (!calendar) {
      calendar = this.calendar.calendarIn(tx, ctx);
      this.calendars.set(tx, calendar);
    }
    return calendar;
  }
}
