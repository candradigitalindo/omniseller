import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { NotificationInboxService } from "../notification/inbox.service";
import { InventoryService } from "./inventory.service";
import { WarehousesService } from "./warehouses.service";

/** How many items a notification names in its text; the data carries up to 50. */
const NAMED = 3;

/**
 * Critical stock notifications (PRD FR-NTF-01): after stock changes, variants that ran out or fell to
 * their minimum in a warehouse are announced once to the people who can restock (`inventory:adjust`)
 * and see that warehouse. Recovering stock clears the alert, so the next drop is announced again.
 */
@Injectable()
export class StockAlertsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  async check(ctx: RequestContext, pairs: { variantId: string; warehouseId: string }[]): Promise<number> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const alerts = await this.inventory.stockAlertsIn(tx, pairs);
      if (alerts.length === 0) return 0;
      const names = new Map((await this.warehouses.activeIn(tx)).map((w) => [w.id, w.name]));
      const items = alerts.map((a) => ({ ...a, storeId: undefined, warehouse: names.get(a.warehouseId) ?? "Gudang" }));
      return this.inbox.notifyScopedIn(tx, ctx, "inventory:adjust", items, (theirs) => {
        const out = theirs.filter((t) => t.level === "out").length;
        const low = theirs.length - out;
        const label = (t: (typeof theirs)[number]) =>
          `${t.variant.sku} (${t.level === "out" ? "habis" : `sisa ${t.available}`}, ${t.warehouse})`;
        const more = theirs.length > NAMED ? `, dan ${theirs.length - NAMED} lainnya` : "";
        return {
          kind: "stock.critical",
          severity: out > 0 ? "critical" : "warning",
          title: [out > 0 ? `${out} produk stok habis` : null, low > 0 ? `${low} produk stok menipis` : null]
            .filter(Boolean)
            .join(", "),
          body: `${theirs.slice(0, NAMED).map(label).join(", ")}${more}.`,
          data: {
            items: theirs.slice(0, 50).map((t) => ({
              variantId: t.variant.variantId,
              sku: t.variant.sku,
              warehouseId: t.warehouseId,
              level: t.level,
              available: t.available,
              minStock: t.minStock,
            })),
          },
        };
      });
    });
  }
}
