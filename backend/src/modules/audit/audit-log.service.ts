import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { seesCost } from "../../common/cost-visibility";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { ProductsService } from "../catalog/products.service";
import { StoresService } from "../channel/stores.service";
import { DevicesService } from "../identity/devices.service";
import { RolesService } from "../identity/roles.service";
import { UsersService } from "../identity/users.service";
import { WarehousesService } from "../inventory/warehouses.service";
import { OrdersService } from "../orders/orders.service";
import { type AuditFilter, AuditService } from "./audit.module";
import {
  type AuditDiff,
  type AuditEntryView,
  type AuditLogRow,
  type AuditNames,
  type AuditRef,
  auditDiff,
  auditEntryView,
  refsOf,
} from "./audit-view";

/** Rows read per query while filling a page, and at most per page (a page may then hold fewer). */
const BATCH = 200;
const MAX_SCANNED = 2_000;

export type AuditLogEntry = AuditLogRow & AuditEntryView;

/**
 * The audit log as a seller reads it (PRD FR-USR-04, backend doc 8.28): rows a person would recognise,
 * who acted by name, and the records each row points at named by the module that owns them, so readers
 * with audit:read but not settings:user (Admin) still see who did what. Cost prices stay with finance:read.
 */
@Injectable()
export class AuditLogService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(RolesService) private readonly roles: RolesService,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(ProductsService) private readonly products: ProductsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  /**
   * One page, newest first. Rows that changed nothing a seller would see are skipped, and reading goes
   * on until the page is full; after MAX_SCANNED rows the page ends early and the cursor continues there.
   */
  async list(
    ctx: RequestContext,
    filter: AuditFilter,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: AuditLogEntry[]; next_cursor: string | null }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const found: { row: AuditLogRow; diff: AuditDiff }[] = [];
      let before = decodeCursor(cursor);
      let scanned = 0;
      let next: string | null = null;
      read: for (;;) {
        const rows: AuditLogRow[] = await this.audit.rowsIn(tx, filter, before, BATCH);
        for (const row of rows) {
          scanned += 1;
          const diff = auditDiff(row);
          if (diff) {
            if (found.length === limit) {
              // one more exists: the next page starts after the last one shown
              next = found[limit - 1]!.row.id;
              break read;
            }
            found.push({ row, diff });
          }
          if (scanned >= MAX_SCANNED) {
            next = row.id;
            break read;
          }
        }
        if (rows.length < BATCH) break;
        before = rows[rows.length - 1]!.id;
      }
      const names = await this.namesIn(tx, found);
      const opts = { seesCost: seesCost(ctx) };
      return {
        items: found.map(({ row, diff }) => ({ ...row, ...auditEntryView(row, diff, names, opts) })),
        next_cursor: next ? encodeCursor(next) : null,
      };
    });
  }

  /** Everyone who may appear in the log, disabled users included: the choices of the person filter. */
  async people(ctx: RequestContext): Promise<{ id: string; name: string }[]> {
    return withTenantTx(this.db, ctx, async (tx) =>
      [...(await this.users.namesIn(tx))]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name, "id")),
    );
  }

  /** Names of what these rows point at and who acted, read once per kind and only when needed. */
  private async namesIn(tx: Tx, rows: { row: AuditLogRow; diff: AuditDiff }[]): Promise<AuditNames> {
    const refs = refsOf(rows);
    const ids = (ref: AuditRef) => [...(refs.get(ref) ?? [])];
    const needs = (ref: AuditRef) => (refs.get(ref)?.size ?? 0) > 0;
    const actorTypes = new Set(rows.filter((r) => r.row.actorId).map((r) => r.row.actorType));
    const empty = new Map<string, string>();
    const byRef: Record<AuditRef, Map<string, string>> = {
      user: needs("user") || actorTypes.has("user") ? await this.users.namesIn(tx) : empty,
      role: needs("role") ? await this.roles.namesIn(tx) : empty,
      permission: needs("permission") ? await this.roles.permissionNamesIn(tx) : empty,
      store: needs("store") ? await this.stores.namesIn(tx) : empty,
      warehouse: needs("warehouse") ? await this.warehouses.namesIn(tx) : empty,
      channelWarehouse: needs("channelWarehouse") ? await this.stores.channelWarehouseNamesIn(tx) : empty,
      variant: needs("variant") ? await this.products.variantSkusIn(tx, ids("variant")) : empty,
      order: needs("order") ? await this.orders.numbersIn(tx, ids("order")) : empty,
    };
    const devices = actorTypes.has("device") ? await this.devices.namesIn(tx) : empty;
    return {
      of: (ref, id) => byRef[ref].get(id) ?? null,
      actor: (type, id) => {
        if (!id) return null;
        if (type === "user") return byRef.user.get(id) ?? null;
        if (type === "device") return devices.get(id) ?? null;
        return null;
      },
    };
  }
}
