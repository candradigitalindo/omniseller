import {
  isConnectorError,
  type ListingPriceResult,
  type ListingPriceUpdate,
  PermanentConnectorError,
  type ShopCredentials,
} from "@omniseller/connector-core";
import type { TiktokShopClient } from "./client.js";

/** Update Price 202309: active local Indonesian SKUs, regular prices, no active promotions. */
export function tiktokPrices(client: TiktokShopClient) {
  return {
    async updatePrices(
      shop: ShopCredentials,
      updates: ListingPriceUpdate[],
      context?: { crossBorder: boolean },
    ): Promise<ListingPriceResult[]> {
      const groups = new Map<string, ListingPriceUpdate[]>();
      const keys = new Set<string>();
      for (const row of updates) {
        const key = `${row.externalItemId}/${row.externalVariantId}`;
        if (
          !/^[1-9]\d*$/.test(row.externalItemId) ||
          !/^[1-9]\d*$/.test(row.externalVariantId) ||
          keys.has(key) ||
          !Number.isSafeInteger(row.price) ||
          row.price <= 0
        )
          throw new PermanentConnectorError({ code: "invalid_request", message: "Invalid price update" });
        keys.add(key);
        groups.set(row.externalItemId, [...(groups.get(row.externalItemId) ?? []), row]);
      }
      const results = new Map<ListingPriceUpdate, ListingPriceResult>();
      for (const [itemId, rows] of groups) {
        try {
          await client.call({
            method: "POST",
            path: `/product/202309/products/${encodeURIComponent(itemId)}/prices/update`,
            accessToken: shop.accessToken,
            shopCipher: shop.shopCipher,
            body: {
              skus: rows.map((row) => ({
                id: row.externalVariantId,
                price: {
                  ...(context?.crossBorder ? { sale_price: String(row.price) } : { amount: String(row.price) }),
                  currency: "IDR",
                },
              })),
            },
          });
          for (const row of rows) results.set(row, { ...row, ok: true });
        } catch (error) {
          if (!isConnectorError(error) || error.kind !== "permanent") throw error;
          for (const row of rows) results.set(row, { ...row, ok: false, errorCode: error.code });
        }
      }
      return updates.map((row) => results.get(row)!);
    },
  };
}
