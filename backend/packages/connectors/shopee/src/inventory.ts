import {
  type ConnectorError,
  isConnectorError,
  type ShopCredentials,
  type StockUpdate,
  type StockUpdateResult,
} from "@omniseller/connector-core";
import type { ShopeeClient } from "./client.js";
import { numericId, shopeeId } from "./identifiers.js";

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
    success_list?: { model_id?: number | string; location_id?: string; stock?: number }[];
    failure_list?: { model_id?: number | string; failed_reason?: string }[];
  };
}

const modelId = (externalVariantId: string) => shopeeId(externalVariantId || "0");

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
      if (shopeeId(itemId) === null || modelId(u.externalVariantId) === null) {
        fail(u, "Id item atau model Shopee tidak valid.");
        return false;
      }
      if (
        u.warehouses.length === 0 ||
        new Set(u.warehouses.map((w) => w.externalWarehouseId)).size !== u.warehouses.length ||
        u.warehouses.some((w) => !Number.isSafeInteger(w.quantity) || w.quantity < 0)
      ) {
        fail(u, "Jumlah atau lokasi stok Shopee tidak valid.");
        return false;
      }
      return true;
    });
    for (let i = 0; i < valid.length; i += MODELS_PER_CALL) {
      const chunk = valid.slice(i, i + MODELS_PER_CALL);
      const body = {
        item_id: numericId(itemId),
        stock_list: chunk.map((u) => ({
          model_id: numericId(u.externalVariantId || "0"),
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
      const failures = res.response?.failure_list;
      const successes = res.response?.success_list;
      const malformed =
        !Array.isArray(successes) ||
        (failures !== undefined && !Array.isArray(failures)) ||
        (Array.isArray(failures) && failures.some((f) => !f || shopeeId(f.model_id) === null)) ||
        (Array.isArray(successes) && successes.some((s) => !s || shopeeId(s.model_id) === null));
      const failed = new Map<string, string>();
      if (Array.isArray(failures)) {
        for (const f of failures) {
          const id = f && shopeeId(f.model_id);
          if (id !== null) failed.set(id, f.failed_reason || res.message || "Gagal memperbarui stok.");
        }
      }
      const topError = res.error && res.error !== "-" ? res.message || res.error : null;
      for (const u of chunk) {
        const id = modelId(u.externalVariantId)!;
        const reason = failed.get(id);
        if (reason !== undefined) fail(u, reason, !REFUSAL.test(reason) && /later|busy|system/i.test(reason));
        else {
          // seller_stock requests return model/location/stock acknowledgements. Every location must
          // match the requested absolute quantity; an absent acknowledgement is never success.
          const ack = Array.isArray(successes) ? successes.filter((s) => s && shopeeId(s.model_id) === id) : [];
          const confirmed =
            !malformed &&
            ack.length === u.warehouses.length &&
            u.warehouses.length > 0 &&
            u.warehouses.every((w) => {
              const location = w.externalWarehouseId === defaultWarehouseId ? "" : w.externalWarehouseId;
              const matches = ack.filter((s) => (s.location_id ?? "") === location);
              return matches.length === 1 && matches[0]?.stock === w.quantity;
            });
          if (confirmed)
            out.set(u, { externalItemId: u.externalItemId, externalVariantId: u.externalVariantId, ok: true });
          else if (topError) fail(u, topError);
          else fail(u, "Shopee belum mengonfirmasi stok untuk semua lokasi model ini.", true);
        }
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
