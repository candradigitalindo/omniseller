import {
  type ArrangedPackage,
  type ArrangeResult,
  type HandoverMethod,
  isConnectorError,
  isPdf,
  type LabelResult,
  type PackageRef,
  PermanentConnectorError,
  requestFile,
  type ShopCredentials,
} from "@omniseller/connector-core";
import type { TiktokShopClient } from "./client.js";
import { TIKTOK_PACKAGE_STATES, type TiktokOrder } from "./orders.js";

/**
 * TikTok Shop fulfillment, "schedule shipping" as documented for SEA (Fulfillment API overview):
 *
 * 1. Get Order Detail (202507): package ids per line item, package status, shipping type
 * 2. Get Package Handover Time Slots (202309): whether pickup or drop-off is possible, pickup slots
 * 3. Ship Package (202309): handover method PICKUP with a slot, or DROP_OFF
 * 4. Get Package Shipping Document (202309): a URL to the label PDF (A6 by default, valid 24 hours)
 *    and the tracking number
 *
 * Packages the seller ships with an own courier (shipping type SELLER) need the seller's tracking
 * number and are left to Seller Center. Before shipping, the order must not be cancelled or waiting
 * for the seller's answer to a cancellation request.
 */
const DETAIL_BATCH = 50;

interface Slots {
  can_pickup?: boolean;
  can_drop_off?: boolean;
  pickup_slots?: { start_time?: number; end_time?: number; avaliable?: boolean; available?: boolean }[];
}

interface ShippingDocument {
  doc_url?: string;
  tracking_number?: string;
}

const NOT_READY: Record<string, string> = {
  waiting: "Paket belum siap dikirim.",
  shipped: "Paket sudah diserahkan ke kurir.",
  delivered: "Paket sudah sampai.",
  cancelled: "Pengiriman paket ini dibatalkan.",
  failed: "Pengiriman paket ini gagal.",
};

/** Permanent failures become the package's result; transient and authorization ones are retried. */
function asResult(err: unknown): { code: string; message: string } {
  if (isConnectorError(err) && err.kind === "permanent") {
    return { code: err.code, message: err.message.replace(/^[^:]+:\s*/, "") };
  }
  throw err;
}

/** Ship Package body: pickup in the earliest open slot (when slots are offered), or drop-off. */
export function chooseTiktokHandover(
  slots: Slots,
  method: HandoverMethod,
): { ok: true; body: Record<string, unknown>; pickupAt: Date | null } | { ok: false; code: string; message: string } {
  if (method === "dropoff") {
    if (slots.can_drop_off !== true) {
      return {
        ok: false,
        code: "method_unavailable",
        message: `Drop-off tidak tersedia untuk paket ini${slots.can_pickup ? "; pilih pickup" : ""}.`,
      };
    }
    return { ok: true, body: { handover_method: "DROP_OFF" }, pickupAt: null };
  }
  if (slots.can_pickup !== true) {
    return {
      ok: false,
      code: "method_unavailable",
      message: `Pickup tidak tersedia untuk paket ini${slots.can_drop_off ? "; pilih drop-off" : ""}.`,
    };
  }
  // the documented field is spelled "avaliable"; "available" is read too in case it is corrected
  const open = (slots.pickup_slots ?? [])
    .filter((s) => (s.avaliable ?? s.available) !== false && s.start_time && s.end_time)
    .sort((a, b) => a.start_time! - b.start_time!);
  const slot = open[0];
  return {
    ok: true,
    body: {
      handover_method: "PICKUP",
      ...(slot ? { pickup_slot: { start_time: slot.start_time, end_time: slot.end_time } } : {}),
    },
    pickupAt: slot ? new Date(slot.start_time! * 1000) : null,
  };
}

export function tiktokFulfillment(client: TiktokShopClient) {
  async function readOrders(shop: ShopCredentials, ids: string[]): Promise<Map<string, TiktokOrder>> {
    const out = new Map<string, TiktokOrder>();
    for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
      const data = await client.call<{ orders?: TiktokOrder[] }>({
        method: "GET",
        path: "/order/202507/orders",
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
        query: { ids: ids.slice(i, i + DETAIL_BATCH).join(",") },
      });
      for (const o of data.orders ?? []) if (o.id) out.set(String(o.id), o);
    }
    return out;
  }

  async function shipOne(shop: ShopCredentials, packageId: string, method: HandoverMethod): Promise<ArrangedPackage> {
    try {
      const slots = await client.call<Slots>({
        method: "GET",
        path: `/fulfillment/202309/packages/${encodeURIComponent(packageId)}/handover_time_slots`,
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
      });
      const choice = chooseTiktokHandover(slots, method);
      if (!choice.ok) return { externalPackageId: packageId, ok: false, code: choice.code, message: choice.message };
      await client.call({
        method: "POST",
        path: `/fulfillment/202309/packages/${encodeURIComponent(packageId)}/ship`,
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
        body: choice.body,
      });
      return { externalPackageId: packageId, ok: true, pickupAt: choice.pickupAt };
    } catch (err) {
      return { externalPackageId: packageId, ok: false, ...asResult(err) };
    }
  }

  return {
    async arrange(
      shop: ShopCredentials,
      input: { externalOrderIds: string[]; method: HandoverMethod },
    ): Promise<ArrangeResult[]> {
      const ids = [...new Set(input.externalOrderIds.filter(Boolean))];
      const orders = await readOrders(shop, ids);
      const results: ArrangeResult[] = [];
      for (const id of ids) {
        const o = orders.get(id);
        const result: ArrangeResult = { externalOrderId: id, packages: [] };
        results.push(result);
        if (!o) {
          result.error = { code: "order_not_found", message: "Pesanan tidak ditemukan di TikTok Shop." };
          continue;
        }
        if (o.shipping_type === "SELLER") {
          result.error = {
            code: "seller_shipping",
            message: "Pesanan ini dikirim dengan kurir sendiri. Masukkan nomor resi di Seller Center.",
          };
          continue;
        }
        if (o.status !== "AWAITING_SHIPMENT" && o.status !== "AWAITING_COLLECTION") {
          result.error = {
            code: "order_not_ready",
            message: `Pesanan berstatus ${o.status ?? "tidak dikenal"} di TikTok Shop dan belum bisa diatur pengirimannya.`,
          };
          continue;
        }
        if (o.is_buyer_request_cancel) {
          result.error = {
            code: "cancel_requested",
            message: "Pembeli mengajukan pembatalan. Tanggapi pengajuannya dulu di Seller Center.",
          };
          continue;
        }
        const status = new Map<string, string>();
        for (const l of o.line_items ?? []) {
          if (l.package_id && !status.has(String(l.package_id)))
            status.set(String(l.package_id), l.package_status ?? "");
        }
        for (const p of o.packages ?? []) if (p.id && !status.has(String(p.id))) status.set(String(p.id), "");
        if (status.size === 0) {
          result.error = { code: "no_package", message: "TikTok Shop belum membuat paket untuk pesanan ini." };
          continue;
        }
        for (const [packageId, s] of status) {
          const state = TIKTOK_PACKAGE_STATES[s] ?? (s === "" ? "ready" : "waiting");
          if (state === "arranged") {
            result.packages.push({ externalPackageId: packageId, ok: true, alreadyArranged: true });
          } else if (state !== "ready") {
            result.packages.push({
              externalPackageId: packageId,
              ok: false,
              code: `package_${state}`,
              message: NOT_READY[state] ?? "Paket belum bisa diatur pengirimannya.",
            });
          } else {
            result.packages.push(await shipOne(shop, packageId, input.method));
          }
        }
      }
      return results;
    },

    async labels(shop: ShopCredentials, refs: PackageRef[]): Promise<LabelResult[]> {
      const out: LabelResult[] = [];
      for (const ref of refs) {
        try {
          const doc = await client.call<ShippingDocument>({
            method: "GET",
            path: `/fulfillment/202309/packages/${encodeURIComponent(ref.externalPackageId)}/shipping_documents`,
            accessToken: shop.accessToken,
            shopCipher: shop.shopCipher,
            query: { document_type: "SHIPPING_LABEL", document_size: "A6", document_format: "PDF" },
          });
          const trackingNumber = doc.tracking_number || null;
          if (!doc.doc_url) {
            out.push({ ref, state: "pending", trackingNumber, message: "Label sedang dibuat TikTok Shop." });
            continue;
          }
          // a plain download from TikTok Shop's file host, valid for 24 hours, no signature
          const file = await requestFile(
            client.config.http ?? {},
            { method: "GET", url: new URL(doc.doc_url) },
            () => undefined,
          );
          if (!file.bytes) {
            throw new PermanentConnectorError({ code: "no_file", message: "label download returned no file" });
          }
          out.push(
            isPdf(file.bytes)
              ? { ref, state: "ready", pdf: file.bytes, trackingNumber }
              : {
                  ref,
                  state: "failed",
                  code: "not_pdf",
                  message: "TikTok Shop mengirim label bukan dalam format PDF.",
                },
          );
        } catch (err) {
          out.push({ ref, state: "failed", ...asResult(err) });
        }
      }
      return out;
    },
  };
}
