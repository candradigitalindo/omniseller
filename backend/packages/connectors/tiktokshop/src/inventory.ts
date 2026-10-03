import {
  isConnectorError,
  type ShopCredentials,
  type StockUpdate,
  type StockUpdateResult,
} from "@omniseller/connector-core";
import type { TiktokShopClient } from "./client.js";

/**
 * Update Inventory (POST /product/202309/products/{product_id}/inventory/update):
 * - one product per call, with the SKUs that change (a product has at most 100 SKUs)
 * - every warehouse assigned to a SKU must be listed with its quantity: none left out, none added
 * - the product must be DRAFT, PENDING, FAILED, ACTIVATE or SELLER_DEACTIVATED
 * - quantity is documented as [1, 99,999]; 0 is still sent for a sold-out SKU (Seller Center allows
 *   it), and a refusal comes back per SKU like any other
 * - `code` 0 can still carry `data.errors` per SKU and warehouse
 * - fulfillment warehouses (FBT, Dilayani Tokopedia) cannot be edited; the backend never sends them
 */
const SKUS_PER_CALL = 100;
export const TIKTOK_MAX_STOCK = 99_999;

interface UpdateInventoryData {
  errors?: {
    code?: number;
    message?: string;
    detail?: { sku_id?: string; extra_errors?: { warehouse_id?: string; code?: number; message?: string }[] };
  }[];
}

export function tiktokInventory(client: TiktokShopClient) {
  async function updateProduct(
    shop: ShopCredentials,
    productId: string,
    updates: StockUpdate[],
  ): Promise<Map<StockUpdate, StockUpdateResult>> {
    const out = new Map<StockUpdate, StockUpdateResult>();
    const record = (u: StockUpdate, error?: string, retryable = false) =>
      out.set(
        u,
        error === undefined
          ? { externalItemId: u.externalItemId, externalVariantId: u.externalVariantId, ok: true }
          : { externalItemId: u.externalItemId, externalVariantId: u.externalVariantId, ok: false, error, retryable },
      );

    const valid = updates.filter((u) => {
      if (u.externalVariantId) return true;
      record(u, "SKU TikTok Shop tanpa id.");
      return false;
    });
    for (let i = 0; i < valid.length; i += SKUS_PER_CALL) {
      const chunk = valid.slice(i, i + SKUS_PER_CALL);
      let data: UpdateInventoryData;
      try {
        data = await client.call<UpdateInventoryData>({
          method: "POST",
          path: `/product/202309/products/${encodeURIComponent(productId)}/inventory/update`,
          accessToken: shop.accessToken,
          shopCipher: shop.shopCipher,
          body: {
            skus: chunk.map((u) => ({
              id: u.externalVariantId,
              inventory: u.warehouses.map((w) => ({
                warehouse_id: w.externalWarehouseId,
                quantity: Math.min(Math.max(w.quantity, 0), TIKTOK_MAX_STOCK),
              })),
            })),
          },
        });
      } catch (err) {
        if (!isConnectorError(err) || err.kind === "auth_expired" || err.kind === "auth_revoked") throw err;
        for (const u of chunk) record(u, err.message, err.kind === "transient");
        continue;
      }
      const failed = new Map<string, string>();
      for (const e of data.errors ?? []) {
        const sku = e.detail?.sku_id;
        if (!sku) continue;
        const extra = (e.detail?.extra_errors ?? [])
          .map((x) => (x.warehouse_id ? `${x.message ?? x.code} (gudang ${x.warehouse_id})` : (x.message ?? "")))
          .filter(Boolean)
          .join("; ");
        failed.set(String(sku), extra || e.message || `error ${e.code ?? ""}`.trim());
      }
      for (const u of chunk) record(u, failed.get(u.externalVariantId));
    }
    return out;
  }

  return {
    async updateStock(shop: ShopCredentials, updates: StockUpdate[]): Promise<StockUpdateResult[]> {
      const byProduct = new Map<string, StockUpdate[]>();
      for (const u of updates) byProduct.set(u.externalItemId, [...(byProduct.get(u.externalItemId) ?? []), u]);
      const results = new Map<StockUpdate, StockUpdateResult>();
      for (const [productId, list] of byProduct) {
        for (const [u, r] of await updateProduct(shop, productId, list)) results.set(u, r);
      }
      return updates.map((u) => results.get(u)!);
    },
  };
}
