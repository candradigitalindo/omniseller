import {
  isConnectorError,
  type ListingPriceResult,
  type ListingPriceUpdate,
  PermanentConnectorError,
  type ShopCredentials,
} from "@omniseller/connector-core";
import type { ShopeeClient } from "./client.js";

/** Node 24 raw JSON keeps Shopee's int64 request identifiers exact as JSON numbers. */
function numericId(value: string): unknown {
  if (!/^\d+$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n)
    throw new PermanentConnectorError({ code: "invalid_request", message: "Invalid Shopee identifier" });
  return (JSON as typeof JSON & { rawJSON(value: string): unknown }).rawJSON(BigInt(value).toString());
}

export function shopeePrices(client: ShopeeClient) {
  return {
    async updatePrices(shop: ShopCredentials, updates: ListingPriceUpdate[]): Promise<ListingPriceResult[]> {
      const groups = new Map<string, ListingPriceUpdate[]>();
      const keys = new Set<string>();
      for (const row of updates) {
        numericId(row.externalItemId);
        numericId(row.externalVariantId || "0");
        const key = `${row.externalItemId}/${row.externalVariantId}`;
        if (keys.has(key) || !Number.isSafeInteger(row.price) || row.price <= 0)
          throw new PermanentConnectorError({ code: "invalid_request", message: "Invalid price update" });
        keys.add(key);
        groups.set(row.externalItemId, [...(groups.get(row.externalItemId) ?? []), row]);
      }
      const results = new Map<ListingPriceUpdate, ListingPriceResult>();
      for (const [itemId, rows] of groups) {
        for (let offset = 0; offset < rows.length; offset += 50) {
          const batch = rows.slice(offset, offset + 50);
          try {
            const result = await client.shopCall<{
              response?: {
                success_list?: { model_id: string | number; original_price: number }[];
                failure_list?: { model_id: string | number; failed_reason?: string }[];
              };
            }>(shop, "POST", "/api/v2/product/update_price", {
              body: {
                item_id: numericId(itemId),
                price_list: batch.map((row) => ({
                  model_id: numericId(row.externalVariantId || "0"),
                  original_price: row.price,
                })),
              },
              passErrors: ["error_update_price_fail"],
            });
            for (const row of batch) {
              const model = row.externalVariantId || "0";
              const failed = result.response?.failure_list?.find((r) => String(r.model_id) === model);
              const success = result.response?.success_list?.find((r) => String(r.model_id) === model);
              results.set(row, {
                ...row,
                ok: !failed && success?.original_price === row.price,
                ...(!failed && success?.original_price === row.price
                  ? {}
                  : { errorCode: failed ? "price_rejected" : "bad_response" }),
              });
            }
          } catch (error) {
            if (!isConnectorError(error) || error.kind !== "permanent") throw error;
            for (const row of batch) results.set(row, { ...row, ok: false, errorCode: error.code });
          }
        }
      }
      return updates.map((row) => results.get(row)!);
    },
  };
}
