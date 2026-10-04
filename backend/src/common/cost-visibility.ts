import type { Permission } from "@omniseller/shared";
import type { RequestContext } from "./context/request-context";

/**
 * Cost prices (HPP) and what they reveal (stock value, gross profit) are finance data: only holders of
 * `finance:read` see them (UI L41 "Peran Gudang tidak bisa melihat harga dan laba", backend doc 8.24).
 * Writing a cost price stays with `catalog:write`; views give `null` instead of the number.
 */
export const COST_PERMISSION: Permission = "finance:read";

export function seesCost(ctx: RequestContext): boolean {
  return ctx.permissions.has(COST_PERMISSION);
}
