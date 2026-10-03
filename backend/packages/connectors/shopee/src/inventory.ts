import {
  type ConnectorError,
  isConnectorError,
  type ShopCredentials,
  type StockUpdate,
  type StockUpdateResult,
} from "@omniseller/connector-core";
import type { ShopeeClient } from "./client.js";

/**
 * v2.product.update_stock (Shopee Open Platform, product module):
 * - one item per call, `stock_list` of 1 to 50 models; `model_id` 0 is an item without models
 * - only `seller_stock` is written; Shopee-held (FBS) stock is never touched
 * - `location_id` follows the item's existing stock structure: items stocked per location need it,
 *   items stocked without one must not have it. The listing pull keeps that structure (stock without a
 *   location sits under the shop-level warehouse id), so each update mirrors what the item already has.
 * - per-model results in `success_list` / `failure_list`; a top-level `error` can come together with a
 *   filled failure_list, so neither the envelope nor the lists alone decide the outcome
 * - stock below the promotion-reserved stock, deleted items, and FBS-only shops are refused per model
 */
const MODELS_PER_CALL = 50;
/** Failure reasons that describe the item or the shop, not a passing condition. */
const REFUSAL = /location|reserve|promotion|stock|deleted|status|fbs|holiday|penalty|vsku|not found|not belong/i;

interface UpdateStockResponse {
  response?: {
    success_list?: { model_id?: number; location_id?: string; stock?: number }[];
    failure_list?: { model_id?: number; failed_reason?: string }[];
  };
}

function modelId(externalVariantId: string): number | null {
  if (externalVariantId === "") return 0;
  return /^\d+$/.test(externalVariantId) ? Number(externalVariantId) : null;
}

function retryable(err: ConnectorError): boolean {
  return err.kind === "transient" && !REFUSAL.test(err.message.replace(/^[^:]*:/, ""));
}

export function shopeeInventory(client: ShopeeClient, defaultWarehouseId: string) {
  async function updateItem(
    shop: ShopCredentials,
    itemId: string,
    updates: StockUpdate[],
  ): Promise<Map<StockUpdate, StockUpdateResult>> {
    const out = new Map<StockUpdate, StockUpdateResult>();
    const fail = (u: StockUpdate, error: string, retry = false) =>
      out.set(u, {
        externalItemId: u.externalItemId,
        externalVariantId: u.externalVariantId,
        ok: false,
        error,
        retryable: retry,
      });

    const valid = updates.filter((u) => {
      if (/^\d+$/.test(itemId) && modelId(u.externalVariantId) !== null) return true;
      fail(u, "Id item atau model Shopee tidak valid.");
      return false;
    });
    for (let i = 0; i < valid.length; i += MODELS_PER_CALL) {
      const chunk = valid.slice(i, i + MODELS_PER_CALL);
      const body = {
        item_id: Number(itemId),
        stock_list: chunk.map((u) => ({
          model_id: modelId(u.externalVariantId)!,
          seller_stock: u.warehouses.map((w) =>
            w.externalWarehouseId === defaultWarehouseId
              ? { stock: w.quantity }
              : { location_id: w.externalWarehouseId, stock: w.quantity },
          ),
        })),
      };
      let res: UpdateStockResponse & { error?: string; message?: string };
      try {
        res = await client.shopCall<UpdateStockResponse>(shop, "POST", "/api/v2/product/update_stock", {
          body,
          passErrors: ["error_busi_update_stock_failed"],
        });
      } catch (err) {
        if (!isConnectorError(err) || err.kind === "auth_expired" || err.kind === "auth_revoked") throw err;
        for (const u of chunk) fail(u, err.message, retryable(err));
        continue;
      }
      const failed = new Map<number, string>();
      for (const f of res.response?.failure_list ?? []) {
        failed.set(Number(f.model_id ?? 0), f.failed_reason || res.message || "Gagal memperbarui stok.");
      }
      const topError = res.error && res.error !== "-" ? res.message || res.error : null;
      const succeeded = new Set((res.response?.success_list ?? []).map((s) => Number(s.model_id ?? 0)));
      for (const u of chunk) {
        const id = modelId(u.externalVariantId)!;
        const reason = failed.get(id);
        if (reason !== undefined) fail(u, reason, !REFUSAL.test(reason) && /later|busy|system/i.test(reason));
        else if (topError && !succeeded.has(id)) fail(u, topError);
        else out.set(u, { externalItemId: u.externalItemId, externalVariantId: u.externalVariantId, ok: true });
      }
    }
    return out;
  }

  return {
    async updateStock(shop: ShopCredentials, updates: StockUpdate[]): Promise<StockUpdateResult[]> {
      const byItem = new Map<string, StockUpdate[]>();
      for (const u of updates) byItem.set(u.externalItemId, [...(byItem.get(u.externalItemId) ?? []), u]);
      const results = new Map<StockUpdate, StockUpdateResult>();
      for (const [itemId, list] of byItem) {
        for (const [u, r] of await updateItem(shop, itemId, list)) results.set(u, r);
      }
      return updates.map((u) => results.get(u)!);
    },
  };
}
