import type { ListingRow } from "../catalog/catalog.repository";
import { dataOf } from "../catalog/listings.service";
import type { StockTarget } from "../channel/stores.service";
import type { RuleRow } from "./inventory.repository";
import type { AllocationRule, PlanListing, PlanStore } from "./stock-plan";

/** Database rows to the inputs of the pure stock plan (stock-plan.ts). */
export function toPlanStore(t: StockTarget): PlanStore {
  return {
    id: t.store.id,
    usable: t.usable,
    live: t.store.syncMode === "live",
    maxStockQuantity: t.maxStockQuantity,
    warehouses: t.warehouses.map((w) => ({
      id: w.id,
      externalId: w.externalWarehouseId,
      kind: w.kind,
      warehouseId: w.mappingStatus === "mapped" ? w.warehouseId : null,
      active: w.active,
      isDefault: w.isDefault,
    })),
  };
}

export function toRule(r: RuleRow): AllocationRule {
  return {
    id: r.id,
    storeId: r.storeId,
    channelWarehouseId: r.channelWarehouseId,
    variantId: r.variantId,
    mode: r.mode,
    value: r.value,
    buffer: r.buffer,
    priority: r.priority,
    active: r.active,
  };
}

/** A mapped listing; its stock keys are the locations it reported at its last pull. */
export function toPlanListing(l: ListingRow): PlanListing {
  return {
    id: l.id,
    storeId: l.storeId,
    variantId: l.variantId!,
    externalItemId: l.externalItemId,
    externalVariantId: l.externalVariantId,
    status: l.status,
    stockKeys: Object.keys(dataOf(l).stockByWarehouse ?? {}),
  };
}
