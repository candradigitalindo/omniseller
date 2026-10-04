import { nearness } from "../../common/region";

/**
 * Which warehouse serves an order whose warehouse no marketplace fixed (backend doc 8.21, PRD FR-ORD-12):
 * manual orders, and orders of stores without multi-warehouse that turned automatic allocation on.
 * A pure function: the service loads warehouses and stock and calls it.
 */

export interface AllocationWarehouse {
  id: string;
  name: string;
  province: string | null;
  isDefault: boolean;
}

export interface AllocationLine {
  variantId: string;
  qty: number;
}

export interface Allocation {
  warehouseId: string | null;
  /**
   * `nearest`: has every item, same province or island group as the buyer; `stock`: has every item;
   * `home`: no warehouse has every item, the preferred one takes the order (and shows the shortage);
   * `none`: no warehouse to choose from.
   */
  reason: "nearest" | "stock" | "home" | "none";
}

/**
 * Picks the warehouse that has every item in stock (established stock only, ADR-036), nearest to the
 * buyer first: same province, then same island group. Ties go to the preferred warehouse (`home`: the
 * store's default), then the business's default, then the one with the most units of these items, then
 * by name. When none has every item, the order goes to the preferred warehouse, or the default.
 */
export function chooseWarehouse(input: {
  warehouses: readonly AllocationWarehouse[];
  lines: readonly AllocationLine[];
  /** keyed `${variantId}|${warehouseId}` */
  stock: ReadonlyMap<string, { available: number; established: boolean }>;
  buyerProvince: string | null;
  home: string | null;
}): Allocation {
  const { warehouses } = input;
  if (warehouses.length === 0) return { warehouseId: null, reason: "none" };
  const need = new Map<string, number>();
  for (const l of input.lines) if (l.qty > 0) need.set(l.variantId, (need.get(l.variantId) ?? 0) + l.qty);

  const fallback = (): Allocation => {
    const home =
      warehouses.find((w) => w.id === input.home) ??
      warehouses.find((w) => w.isDefault) ??
      [...warehouses].sort((a, b) => a.name.localeCompare(b.name))[0]!;
    return { warehouseId: home.id, reason: "home" };
  };
  if (need.size === 0) return fallback();

  const units = (w: AllocationWarehouse) => {
    let total = 0;
    for (const [variantId, qty] of need) {
      const s = input.stock.get(`${variantId}|${w.id}`);
      if (!s?.established || s.available < qty) return null;
      total += s.available;
    }
    return total;
  };
  const able = warehouses
    .map((w) => ({ w, units: units(w), near: nearness(input.buyerProvince, w.province) }))
    .filter((x): x is { w: AllocationWarehouse; units: number; near: number } => x.units !== null);
  if (able.length === 0) return fallback();
  able.sort(
    (a, b) =>
      b.near - a.near ||
      Number(b.w.id === input.home) - Number(a.w.id === input.home) ||
      Number(b.w.isDefault) - Number(a.w.isDefault) ||
      b.units - a.units ||
      a.w.name.localeCompare(b.w.name),
  );
  const best = able[0]!;
  return { warehouseId: best.w.id, reason: best.near > 0 ? "nearest" : "stock" };
}
