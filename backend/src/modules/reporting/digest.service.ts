import { Inject, Injectable, Optional } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { startOfDate } from "../../common/time-zone";
import { ENV } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { publicWebUrl, StoresService, statusMessage } from "../channel/stores.service";
import { TenantsService } from "../identity/tenants.service";
import { UsersService } from "../identity/users.service";
import { InventoryService } from "../inventory/inventory.service";
import { EMAIL_SENDER, type EmailSender } from "../notification/email";
import { NotificationPreferencesService } from "../notification/preferences.service";
import { type DigestSummary, dailyDigestEmail } from "../notification/templates";
import { OrdersService } from "../orders/orders.service";
import { storeHealth } from "./dashboard-plan";
import { digestEmailRequested } from "./digest.events";
import { DigestRepository } from "./digest.repository";
import { addDays } from "./sales-report-plan";

const TO_SHIP = ["new", "ready_to_pack", "packed", "ready_to_ship"];

/** "Kaos Polos Hitam, L" as the UI writes it; a product without variants is just its name. */
function itemName(v: { productName: string; variantName: string } | undefined, title: string): string {
  if (!v) return title;
  return v.variantName && v.variantName !== v.productName ? `${v.productName} ${v.variantName}` : v.productName;
}

/**
 * The daily operational email (PRD FR-NTF-02, backend doc 8.20). Each morning the scheduler gives every
 * active business a `digest.daily` job; the first one of a local date claims `daily_digest` and writes one
 * `digest.email_requested` per recipient in the same transaction, so each email is retried on its own
 * and none is sent twice. Recipients: active users with `order:read` whose choice for `digest.daily`
 * is email (on by default with `report:read`). Each email holds the figures of that person's stores
 * and warehouses, and only the sections their permissions show.
 */
@Injectable()
export class DigestService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(DigestRepository) private readonly repo: DigestRepository,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(NotificationPreferencesService) private readonly preferences: NotificationPreferencesService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(EMAIL_SENDER) private readonly email?: EmailSender,
  ) {}

  /** Plans the emails of one local date; returns how many, 0 when that date was done already. */
  async run(ctx: RequestContext, date: string): Promise<number> {
    const profile = await this.tenants.profile(ctx);
    return withTenantTx(this.db, ctx, async (tx) => {
      const digest = await this.repo.claim(tx, { id: newId(), tenantId: ctx.tenantId, digestDate: date });
      if (!digest) return 0;
      const candidates = await this.users.recipientsIn(tx, "order:read");
      const seesSales = new Set((await this.users.recipientsIn(tx, "report:read")).map((u) => u.id));
      const choices = await this.preferences.emailChoicesIn(tx, "digest.daily");
      let planned = 0;
      for (const u of candidates) {
        if (!(choices.get(u.id) ?? seesSales.has(u.id))) continue;
        const principal = await this.users.loadPrincipal(ctx.tenantId, u.id);
        if (principal?.user.status !== "active") continue;
        const reader: RequestContext = {
          ...ctx,
          actor: { type: "user", id: u.id },
          permissions: new Set(principal.permissions),
          storeScope: principal.storeScope ? new Set(principal.storeScope) : null,
          warehouseScope: principal.warehouseScope ? new Set(principal.warehouseScope) : null,
        };
        const summary = await this.summaryIn(tx, reader, profile.timezone, date);
        if (!summary.sales && !summary.orders && !summary.stock && !summary.stores) continue;
        await this.outbox.enqueue(
          tx,
          ctx,
          digestEmailRequested,
          { userId: u.id, tenantName: profile.name, summary },
          u.id,
        );
        planned++;
      }
      await this.repo.setRecipients(tx, digest.id, planned);
      return planned;
    });
  }

  /** Sends one planned email, unless the person left or turned it off meanwhile. */
  async send(ctx: RequestContext, p: { userId: string; tenantName: string; summary: DigestSummary }): Promise<void> {
    if (!this.email) throw new Error("DigestService.send needs an EmailSender (worker process)");
    const principal = await this.users.loadPrincipal(ctx.tenantId, p.userId);
    if (principal?.user.status !== "active") return;
    const choice = await withTenantTx(this.db, ctx, (tx) => this.preferences.emailChoicesIn(tx, "digest.daily"));
    if (choice.get(p.userId) === false) return;
    await this.email.send(
      dailyDigestEmail({
        to: principal.user.email,
        name: principal.user.name,
        tenantName: p.tenantName,
        summary: p.summary,
        url: `${publicWebUrl(this.env)}/`,
      }),
    );
  }

  /** Yesterday's figures for one reader, in their scope; sections by permission. */
  async summaryIn(tx: Tx, ctx: RequestContext, timezone: string, date: string): Promise<DigestSummary> {
    const can = (p: string) => ctx.permissions.has(p);
    const day = addDays(date, -1);
    const from = startOfDate(timezone, day);
    const to = startOfDate(timezone, date);
    const before = startOfDate(timezone, addDays(date, -2));

    let sales: DigestSummary["sales"] = null;
    if (can("report:read")) {
      const now = await this.orders.salesIn(tx, ctx, {}, from, to);
      const prev = await this.orders.salesIn(tx, ctx, {}, before, from);
      const top = await this.orders.itemSalesIn(tx, ctx, {}, from, to, "variant", 3);
      const names = await this.inventory.variantsIn(
        tx,
        top.flatMap((t) => (t.variantId ? [t.variantId] : [])),
      );
      sales = {
        orders: now.orders,
        revenue: now.revenue,
        previousOrders: prev.orders,
        previousRevenue: prev.revenue,
        top: top.map((t) => ({
          name: itemName(t.variantId ? names.get(t.variantId) : undefined, t.title),
          units: t.units,
        })),
      };
    }

    let orders: DigestSummary["orders"] = null;
    if (can("order:read")) {
      const s = await this.orders.summaryIn(tx, ctx, {});
      orders = {
        new: s.statuses.new ?? 0,
        toShip: TO_SHIP.reduce((n, k) => n + (s.statuses[k] ?? 0), 0),
        overdue: s.overdue,
        dueSoon: s.dueSoon,
        problem: s.statuses.problem ?? 0,
      };
    }

    let stock: DigestSummary["stock"] = null;
    if (can("inventory:read")) {
      const c = await this.inventory.criticalIn(tx, ctx, 5);
      stock = {
        critical: c.count,
        items: c.items.map((i) => ({
          sku: i.sku,
          name: i.productName,
          available: i.available,
          warehouse: i.warehouse,
        })),
      };
    }

    let stores: DigestSummary["stores"] = null;
    if (can("settings:store")) {
      const now = new Date();
      stores = [];
      for (const s of await this.stores.listIn(tx, ctx)) {
        if (s.status === "disconnected") continue;
        const h = storeHealth(
          {
            status: s.status,
            reasonText: statusMessage(s.statusReason),
            syncMode: s.syncMode,
            lastOrderSyncAt: s.lastOrderSyncAt,
            unmappedWarehouses: await this.stores.unmappedWarehousesIn(tx, s.id),
          },
          now,
        );
        if (h.health !== "healthy" && h.reason) stores.push({ name: s.name, reason: h.reason });
      }
    }
    return { date: day, sales, orders, stock, stores };
  }
}
