import type { CommerceOperation, CommerceValue } from "@omniseller/connector-core";
import type { RequestContext } from "../../common/context/request-context";
import { seesCost } from "../../common/cost-visibility";

const costKey = (key: string) =>
  /(?:^|_)(?:hpp|cogs|cost|profit|margin|roi|roas|stock_value|inventory_value|purchase_price)(?:_|$)/i.test(
    key.replace(/([a-z])([A-Z])/g, "$1_$2"),
  );

/** Commerce permissions supplement the owning module; an affiliate or ads scope is not a finance grant. */
export function additionalCommercePermissions(operation: CommerceOperation): string[] {
  if (operation.id === "shopee.livestream.get_stream_credentials") return ["affiliate:write"];
  const path = operation.path;
  const financial =
    /\/(?:finance|payment|ads)\//i.test(path) ||
    /(?:balance|escrow|payout|settlement|reconciliation)/i.test(path) ||
    (/\/(?:ams|affiliate_creator|affiliate_partner|affiliate_seller)\//i.test(path) &&
      /(?:validation|conversion|billing|invoice|affiliate_orders|commission_(?:report|detail)|\/orders(?:\/|$))/i.test(
        path,
      )) ||
    operation.responseFields?.some(costKey);
  if (
    operation.transport === "private_download" &&
    /(?:compass|finance|payment|commission|billing|statement)/i.test(path)
  )
    return ["finance:read", "finance:export"];
  return financial ? ["finance:read"] : [];
}

/** Re-evaluated for each API read so a role change also protects a result cached under an older role. */
export function visibleCommerceData(ctx: RequestContext, data: CommerceValue): CommerceValue {
  if (seesCost(ctx)) return data;
  const visit = (value: CommerceValue): CommerceValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, costKey(key) ? null : visit(item)]));
  };
  return visit(data);
}
