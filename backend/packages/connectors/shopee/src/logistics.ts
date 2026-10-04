import {
  type ArrangedPackage,
  type ArrangeResult,
  type HandoverMethod,
  isConnectorError,
  isPdf,
  type LabelResult,
  type PackageRef,
  type ParcelTracking,
  type ShopCredentials,
  type TrackingEvent,
  type TrackingResult,
  type TrackingStage,
  trackingStageOf,
} from "@omniseller/connector-core";
import type { ShopeeClient } from "./client.js";
import { SHOPEE_PACKAGE_STATES, type ShopeePackage } from "./orders.js";

/**
 * Shopee shipment APIs (developer guide "Order Management" 8, v2.logistics), package based:
 *
 * 1. get_order_detail (package_list): the packages, their fulfillment status, channel, and warehouse
 * 2. get_mass_shipping_parameter + mass_ship_order: up to 50 packages of one logistics channel and one
 *    warehouse (product_location_id) per call. get_shipping_parameter + ship_order for an order without
 *    a package number; update_shipping_order for a package whose pickup failed (pickup only).
 * 3. get_mass_tracking_number: the tracking number may come minutes later (push code 4 says when)
 * 4. get_shipping_document_parameter, create_shipping_document, get_shipping_document_result,
 *    download_shipping_document: the airway bill, printable after the shipment is arranged and before
 *    the parcel is picked up (push code 15 says when the document is READY)
 * 5. get_tracking_info: the parcel's journey, per order or per package of a split order (there is no
 *    tracking push; the backend polls)
 *
 * Shopee recommends arranging an hour after the order is placed: until then the buyer may cancel
 * without asking. That is the seller's choice; this connector arranges when asked.
 */
const BATCH = 50;
/** One label per page, about 100 x 150 mm; the backend scales it for thermal printers and A4 sheets. */
const PREFERRED_DOCUMENT = "THERMAL_AIR_WAYBILL";

interface ShippingParameter {
  info_needed?: { pickup?: string[] | null; dropoff?: string[] | null; non_integrated?: string[] | null } | null;
  pickup?: {
    address_list?:
      | {
          address_id?: number | string;
          address_flag?: string[] | null;
          time_slot_list?: { date?: number; pickup_time_id?: string; flags?: string[] | null }[] | null;
        }[]
      | null;
  } | null;
}

type Choice =
  | { ok: true; body: Record<string, unknown>; pickupAt: Date | null }
  | { ok: false; code: string; message: string };

const unavailable = (need: NonNullable<ShippingParameter["info_needed"]>, method: HandoverMethod): Choice => {
  const offered = [
    Array.isArray(need.pickup) ? "pickup" : null,
    Array.isArray(need.dropoff) ? "drop-off" : null,
  ].filter(Boolean);
  if (offered.length === 0 && Array.isArray(need.non_integrated)) {
    return {
      ok: false,
      code: "non_integrated",
      message: "Kurir pesanan ini tidak terintegrasi Shopee. Kirim sendiri lalu isi resi di Seller Center.",
    };
  }
  return {
    ok: false,
    code: "method_unavailable",
    message: `${method === "pickup" ? "Pickup" : "Drop-off"} tidak tersedia untuk pesanan ini${
      offered.length ? `; pilih ${offered.join(" atau ")}` : ""
    }.`,
  };
};

const fail = (code: string, message: string): Choice => ({ ok: false, code, message });

/** Shopee ids are int64; ids that fit a JavaScript number are sent as numbers, as documented. */
const int64 = (v: number | string) => (Number.isSafeInteger(Number(v)) ? Number(v) : v);

/**
 * Pickup or drop-off parameters from get_(mass_)shipping_parameter. Pickup goes to the address Shopee
 * marks as the current one for the warehouse (multi-warehouse sellers; another address may cost more),
 * else the pickup address, else the default; the slot is the one Shopee recommends, else the earliest.
 * Drop-off needs nothing in Indonesia; a channel that wants a branch, the sender's real name, or the
 * seller's tracking number is left to Seller Center.
 */
export function chooseShopeeHandover(param: ShippingParameter, method: HandoverMethod): Choice {
  const need = param.info_needed ?? {};
  if (method === "pickup") {
    const fields = need.pickup;
    if (!Array.isArray(fields)) return unavailable(need, method);
    if (fields.includes("tracking_number")) {
      return fail("tracking_number_required", "Kurir ini meminta nomor resi dari penjual. Atur dari Seller Center.");
    }
    const list = param.pickup?.address_list ?? [];
    const flagged = (flag: string) => list.find((a) => a.address_flag?.includes(flag));
    const address = flagged("current_address") ?? flagged("pickup_address") ?? flagged("default_address") ?? list[0];
    if (fields.includes("address_id") && address?.address_id === undefined) {
      return fail("no_pickup_address", "Alamat pickup belum diatur di Shopee.");
    }
    const slots = [...(address?.time_slot_list ?? [])].sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
    const slot = slots.find((s) => s.flags?.includes("recommended")) ?? slots[0];
    if (fields.includes("pickup_time_id") && !slot?.pickup_time_id) {
      return fail("no_pickup_slot", "Belum ada jadwal pickup yang tersedia. Coba lagi nanti atau pilih drop-off.");
    }
    const pickup: Record<string, unknown> = {};
    if (address?.address_id !== undefined) pickup.address_id = int64(address.address_id);
    if (slot?.pickup_time_id) pickup.pickup_time_id = slot.pickup_time_id;
    return { ok: true, body: { pickup }, pickupAt: slot?.date ? new Date(slot.date * 1000) : null };
  }
  const fields = need.dropoff;
  if (!Array.isArray(fields)) return unavailable(need, method);
  if (fields.includes("branch_id")) {
    return fail("dropoff_branch_required", "Drop-off kurir ini perlu memilih cabang. Atur dari Seller Center.");
  }
  if (fields.includes("sender_real_name")) {
    return fail("dropoff_sender_required", "Drop-off kurir ini perlu nama asli pengirim. Atur dari Seller Center.");
  }
  if (fields.includes("tracking_no") || fields.includes("tracking_number")) {
    return fail("tracking_number_required", "Kurir ini meminta nomor resi dari penjual. Atur dari Seller Center.");
  }
  return { ok: true, body: { dropoff: {} }, pickupAt: null };
}

const NOT_READY: Record<string, string> = {
  waiting: "Paket belum siap dikirim.",
  shipped: "Paket sudah diserahkan ke kurir.",
  delivered: "Paket sudah sampai.",
  cancelled: "Pengiriman paket ini dibatalkan.",
  failed: "Pengiriman paket ini gagal.",
};

interface DetailResponse {
  response?: { order_list?: { order_sn?: string; order_status?: string; package_list?: ShopeePackage[] }[] };
}

interface PackageList<T> {
  success_list?: T[] | null;
  fail_list?: { package_number?: string; fail_reason?: string }[] | null;
}

interface MassParameterResponse {
  response?: ShippingParameter & PackageList<{ package_number?: string }>;
}

type MassShipResponse = PackageList<{ package_number?: string }> & {
  response?: PackageList<{ package_number?: string }>;
};

interface TrackingResponse {
  response?: PackageList<{ package_number?: string; tracking_number?: string; hint?: string }> & {
    tracking_number?: string;
    hint?: string;
  };
}

interface DocumentResult {
  order_sn?: string;
  package_number?: string;
  status?: string;
  suggest_shipping_document_type?: string;
  selectable_shipping_document_type?: string[];
  fail_error?: string;
  fail_message?: string;
}

interface DocumentResponse {
  response?: { result_list?: DocumentResult[] };
}

/** Permanent failures become the package's result; transient and authorization ones are retried. */
function asResult(err: unknown): { code: string; message: string } {
  if (isConnectorError(err) && err.kind === "permanent") {
    return { code: err.code, message: err.message.replace(/^[^:]+:\s*/, "") };
  }
  throw err;
}

const refKey = (r: { order_sn?: string; package_number?: string }) => `${r.order_sn ?? ""}|${r.package_number ?? ""}`;

/** Data Definition "TrackingLogisticsStatus": the status of each tracking event. */
export const SHOPEE_TRACKING_STAGES: Record<string, TrackingStage> = {
  INITIAL: "waiting_pickup",
  ORDER_INIT: "waiting_pickup",
  ORDER_SUBMITTED: "waiting_pickup",
  ORDER_FINALIZED: "waiting_pickup",
  ORDER_CREATED: "waiting_pickup",
  PICKUP_REQUESTED: "waiting_pickup",
  PICKUP_PENDING: "waiting_pickup",
  PICKUP_RETRY: "waiting_pickup",
  UPDATE: "waiting_pickup",
  UPDATE_SUBMITTED: "waiting_pickup",
  UPDATE_CREATED: "waiting_pickup",
  PICKED_UP: "in_transit",
  DELIVERY_PENDING: "in_transit",
  DELIVERED: "delivered",
  TIMEOUT: "failed",
  LOST: "lost",
  RETURN_STARTED: "returning",
  RETURN_PENDING: "returning",
  RETURN_INITIATED: "returning",
  RETURNED: "returned",
  EXPIRED: "cancelled",
  CANCEL: "cancelled",
  CANCEL_CREATED: "cancelled",
  CANCELED: "cancelled",
  FAILED_ORDER_INIT: "failed",
  FAILED_ORDER_SUBMITTED: "failed",
  FAILED_ORDER_CREATED: "failed",
  FAILED_PICKUP_REQUESTED: "failed",
  FAILED_PICKED_UP: "failed",
  FAILED_DELIVERED: "failed",
  FAILED_UPDATE_SUBMITTED: "failed",
  FAILED_UPDATE_CREATED: "failed",
  FAILED_RETURN_STARTED: "failed",
  FAILED_RETURNED: "failed",
  FAILED_CANCEL_CREATED: "failed",
  FAILED_CANCELED: "failed",
};

/** Data Definition "LogisticsStatus" of the order or package, when no event says more. */
const SHOPEE_LOGISTICS_STAGES: Record<string, TrackingStage> = {
  LOGISTICS_REQUEST_CREATED: "waiting_pickup",
  LOGISTICS_PICKUP_RETRY: "waiting_pickup",
  LOGISTICS_PICKUP_DONE: "in_transit",
  LOGISTICS_DELIVERY_DONE: "delivered",
  LOGISTICS_DELIVERY_FAILED: "failed",
  LOGISTICS_PICKUP_FAILED: "failed",
  LOGISTICS_LOST: "lost",
  LOGISTICS_REQUEST_CANCELED: "cancelled",
  LOGISTICS_INVALID: "cancelled",
};

interface TrackingInfoResponse {
  error?: string;
  response?: {
    logistics_status?: string;
    tracking_info?:
      | { update_time?: number; description?: string; logistics_status?: string; return_code?: string }[]
      | null;
  };
}

const SPLIT_ORDER = "logistics.package_number_not_exist";

/** Events of one get_tracking_info answer, newest first; entries without a time are dropped. */
export function shopeeTrackingEvents(
  info: NonNullable<TrackingInfoResponse["response"]>["tracking_info"],
): TrackingEvent[] {
  return (info ?? [])
    .flatMap((t): TrackingEvent[] => {
      const seconds = Number(t.update_time);
      if (!Number.isFinite(seconds) || seconds <= 0) return [];
      const code = t.logistics_status?.trim() || null;
      return [
        {
          at: new Date(seconds * 1000),
          description: (t.description ?? "").trim(),
          code,
          stage: code ? (SHOPEE_TRACKING_STAGES[code] ?? null) : null,
          ...(t.return_code?.trim() ? { returnCode: t.return_code.trim() } : {}),
        },
      ];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

export function shopeeLogistics(client: ShopeeClient) {
  async function readOrders(shop: ShopCredentials, sns: string[]) {
    const out = new Map<string, NonNullable<NonNullable<DetailResponse["response"]>["order_list"]>[number]>();
    for (let i = 0; i < sns.length; i += BATCH) {
      const data = await client.shopCall<DetailResponse>(shop, "GET", "/api/v2/order/get_order_detail", {
        query: {
          order_sn_list: sns.slice(i, i + BATCH).join(","),
          response_optional_fields: "package_list",
          request_order_status_pending: "true",
        },
      });
      for (const o of data.response?.order_list ?? []) if (o.order_sn) out.set(o.order_sn, o);
    }
    return out;
  }

  /** One package (or an order without package number) through get_shipping_parameter and ship_order. */
  async function arrangeOne(
    shop: ShopCredentials,
    orderSn: string,
    packageNumber: string,
    retry: boolean,
    method: HandoverMethod,
  ): Promise<ArrangedPackage> {
    const ref = { order_sn: orderSn, ...(packageNumber ? { package_number: packageNumber } : {}) };
    try {
      const param = await client.shopCall<{ response?: ShippingParameter }>(
        shop,
        "GET",
        "/api/v2/logistics/get_shipping_parameter",
        { query: ref },
      );
      const choice = chooseShopeeHandover(param.response ?? {}, method);
      if (!choice.ok)
        return { externalPackageId: packageNumber, ok: false, code: choice.code, message: choice.message };
      // a failed pickup is booked again with update_shipping_order (pickup only)
      const path =
        retry && method === "pickup" ? "/api/v2/logistics/update_shipping_order" : "/api/v2/logistics/ship_order";
      await client.shopCall(shop, "POST", path, { body: { ...ref, ...choice.body } });
      return { externalPackageId: packageNumber, ok: true, pickupAt: choice.pickupAt };
    } catch (err) {
      return { externalPackageId: packageNumber, ok: false, ...asResult(err) };
    }
  }

  /** Packages of one channel and warehouse, at most 50, through the mass APIs. */
  async function arrangeGroup(
    shop: ShopCredentials,
    group: { channel: number | string | undefined; location: string | undefined; packages: string[] },
    method: HandoverMethod,
  ): Promise<ArrangedPackage[]> {
    const routing = {
      ...(group.channel !== undefined ? { logistics_channel_id: int64(group.channel) } : {}),
      ...(group.location ? { product_location_id: group.location } : {}),
    };
    const failed = (code: string, message: string, numbers: string[]) =>
      numbers.map((n) => ({ externalPackageId: n, ok: false, code, message }));
    let param: MassParameterResponse;
    try {
      param = await client.shopCall<MassParameterResponse>(
        shop,
        "POST",
        "/api/v2/logistics/get_mass_shipping_parameter",
        { body: { ...routing, package_list: group.packages.map((n) => ({ package_number: n })) } },
      );
    } catch (err) {
      const r = asResult(err);
      return failed(r.code, r.message, group.packages);
    }
    const results: ArrangedPackage[] = [];
    const refused = new Set<string>();
    for (const f of param.response?.fail_list ?? []) {
      if (!f.package_number) continue;
      refused.add(f.package_number);
      results.push({
        externalPackageId: f.package_number,
        ok: false,
        code: "parameter_failed",
        message: f.fail_reason || "Shopee menolak paket ini.",
      });
    }
    const ready = group.packages.filter((n) => !refused.has(n));
    if (ready.length === 0) return results;
    const choice = chooseShopeeHandover(param.response ?? {}, method);
    if (!choice.ok) return [...results, ...failed(choice.code, choice.message, ready)];
    let shipped: MassShipResponse;
    try {
      shipped = await client.shopCall<MassShipResponse>(shop, "POST", "/api/v2/logistics/mass_ship_order", {
        body: { ...routing, package_list: ready.map((n) => ({ package_number: n })), ...choice.body },
      });
    } catch (err) {
      const r = asResult(err);
      return [...results, ...failed(r.code, r.message, ready)];
    }
    // documented at the top level; read the `response` wrapper too, like the other mass APIs
    const lists = shipped.response ?? shipped;
    const failedHere = new Map((lists.fail_list ?? []).map((f) => [f.package_number ?? "", f.fail_reason ?? ""]));
    for (const n of ready) {
      const reason = failedHere.get(n);
      if (reason !== undefined) {
        results.push({ externalPackageId: n, ok: false, code: "ship_failed", message: reason || "Shopee menolak." });
      } else {
        results.push({ externalPackageId: n, ok: true, pickupAt: choice.pickupAt });
      }
    }
    return results;
  }

  async function trackingNumbers(shop: ShopCredentials, refs: PackageRef[]) {
    const out = new Map<string, { trackingNumber: string | null; hint: string | null }>();
    const withPackage = refs.filter((r) => r.externalPackageId);
    for (let i = 0; i < withPackage.length; i += BATCH) {
      const batch = withPackage.slice(i, i + BATCH);
      const data = await client.shopCall<TrackingResponse>(shop, "POST", "/api/v2/logistics/get_mass_tracking_number", {
        body: { package_list: batch.map((r) => ({ package_number: r.externalPackageId })) },
      });
      const byPackage = new Map((data.response?.success_list ?? []).map((s) => [s.package_number ?? "", s]));
      for (const r of batch) {
        const s = byPackage.get(r.externalPackageId);
        out.set(refKey({ order_sn: r.externalOrderId, package_number: r.externalPackageId }), {
          trackingNumber: s?.tracking_number || null,
          hint: s?.hint || null,
        });
      }
    }
    for (const r of refs.filter((x) => !x.externalPackageId)) {
      const data = await client.shopCall<TrackingResponse>(shop, "GET", "/api/v2/logistics/get_tracking_number", {
        query: { order_sn: r.externalOrderId },
      });
      out.set(refKey({ order_sn: r.externalOrderId }), {
        trackingNumber: data.response?.tracking_number || null,
        hint: data.response?.hint || null,
      });
    }
    return out;
  }

  const orderList = (refs: PackageRef[], extra: (r: PackageRef) => Record<string, unknown> = () => ({})) =>
    refs.map((r) => ({
      order_sn: r.externalOrderId,
      ...(r.externalPackageId ? { package_number: r.externalPackageId } : {}),
      ...extra(r),
    }));

  async function documentResults(
    shop: ShopCredentials,
    path: string,
    refs: PackageRef[],
    extra: (r: PackageRef) => Record<string, unknown> = () => ({}),
  ): Promise<Map<string, DocumentResult>> {
    const out = new Map<string, DocumentResult>();
    for (let i = 0; i < refs.length; i += BATCH) {
      const data = await client.shopCall<DocumentResponse>(shop, "POST", path, {
        body: { order_list: orderList(refs.slice(i, i + BATCH), extra) },
        // a batch where every element failed comes with the per-element reasons
        passErrors: ["common.batch_api_all_failed"],
      });
      for (const r of data.response?.result_list ?? []) out.set(refKey(r), r);
    }
    return out;
  }

  /** One parcel's journey; null when Shopee wants the order tracked per package. */
  async function trackOne(
    shop: ShopCredentials,
    orderSn: string,
    packageNumber: string,
  ): Promise<ParcelTracking | null> {
    const data = await client.shopCall<TrackingInfoResponse>(shop, "GET", "/api/v2/logistics/get_tracking_info", {
      query: { order_sn: orderSn, ...(packageNumber ? { package_number: packageNumber } : {}) },
      ...(packageNumber ? {} : { passErrors: [SPLIT_ORDER] }),
    });
    if (data.error === SPLIT_ORDER) return null;
    const events = shopeeTrackingEvents(data.response?.tracking_info);
    const status = data.response?.logistics_status ?? "";
    return {
      externalPackageId: packageNumber,
      stage: trackingStageOf(events, SHOPEE_LOGISTICS_STAGES[status] ?? null),
      events,
    };
  }

  return {
    async arrange(
      shop: ShopCredentials,
      input: { externalOrderIds: string[]; method: HandoverMethod },
    ): Promise<ArrangeResult[]> {
      const sns = [...new Set(input.externalOrderIds.filter(Boolean))];
      const orders = await readOrders(shop, sns);
      const results = new Map<string, ArrangeResult>(sns.map((sn) => [sn, { externalOrderId: sn, packages: [] }]));
      const groups = new Map<
        string,
        { channel: number | string | undefined; location: string | undefined; packages: string[] }
      >();
      const singles: { sn: string; packageNumber: string; retry: boolean }[] = [];

      for (const sn of sns) {
        const o = orders.get(sn);
        const result = results.get(sn)!;
        if (!o) {
          result.error = { code: "order_not_found", message: "Pesanan tidak ditemukan di Shopee." };
          continue;
        }
        const list = o.package_list ?? [];
        if (list.length === 0 || list.every((p) => !p.package_number)) {
          if (o.order_status === "READY_TO_SHIP" || o.order_status === "RETRY_SHIP") {
            singles.push({ sn, packageNumber: "", retry: o.order_status === "RETRY_SHIP" });
          } else if (o.order_status === "PROCESSED") {
            result.packages.push({ externalPackageId: "", ok: true, alreadyArranged: true });
          } else {
            result.error = {
              code: "order_not_ready",
              message: `Pesanan berstatus ${o.order_status ?? "tidak dikenal"} di Shopee dan belum bisa diatur pengirimannya.`,
            };
          }
          continue;
        }
        for (const p of list) {
          const number = p.package_number ?? "";
          if (!number) continue;
          const state = SHOPEE_PACKAGE_STATES[p.logistics_status ?? ""] ?? "waiting";
          if (state === "arranged") {
            result.packages.push({ externalPackageId: number, ok: true, alreadyArranged: true });
          } else if (state !== "ready") {
            result.packages.push({
              externalPackageId: number,
              ok: false,
              code: `package_${state}`,
              message: NOT_READY[state] ?? "Paket belum bisa diatur pengirimannya.",
            });
          } else if (p.logistics_status === "LOGISTICS_PICKUP_RETRY") {
            singles.push({ sn, packageNumber: number, retry: true });
          } else {
            const location = p.item_list?.find((i) => i.product_location_id)?.product_location_id;
            const key = `${p.logistics_channel_id ?? ""}|${location ?? ""}`;
            const g = groups.get(key) ?? { channel: p.logistics_channel_id, location, packages: [] };
            g.packages.push(number);
            groups.set(key, g);
          }
        }
      }

      const orderOfPackage = new Map<string, string>();
      for (const o of orders.values()) {
        for (const p of o.package_list ?? []) if (p.package_number) orderOfPackage.set(p.package_number, o.order_sn!);
      }
      for (const g of groups.values()) {
        for (let i = 0; i < g.packages.length; i += BATCH) {
          const done = await arrangeGroup(shop, { ...g, packages: g.packages.slice(i, i + BATCH) }, input.method);
          for (const p of done) results.get(orderOfPackage.get(p.externalPackageId)!)?.packages.push(p);
        }
      }
      for (const s of singles) {
        results.get(s.sn)!.packages.push(await arrangeOne(shop, s.sn, s.packageNumber, s.retry, input.method));
      }
      return [...results.values()];
    },

    async labels(shop: ShopCredentials, refs: PackageRef[]): Promise<LabelResult[]> {
      const out = new Map<string, LabelResult>();
      const key = (r: PackageRef) => refKey({ order_sn: r.externalOrderId, package_number: r.externalPackageId });
      const tracking = await trackingNumbers(shop, refs);
      const withTracking = refs.filter((r) => tracking.get(key(r))?.trackingNumber);
      for (const r of refs) {
        const t = tracking.get(key(r));
        if (!t?.trackingNumber) {
          out.set(key(r), {
            ref: r,
            state: "pending",
            trackingNumber: null,
            message: t?.hint || "Menunggu nomor resi dari kurir.",
          });
        }
      }
      if (withTracking.length === 0) return refs.map((r) => out.get(key(r))!);

      const params = await documentResults(shop, "/api/v2/logistics/get_shipping_document_parameter", withTracking);
      const typeOf = (r: PackageRef) => {
        const p = params.get(key(r));
        return p?.selectable_shipping_document_type?.includes(PREFERRED_DOCUMENT)
          ? PREFERRED_DOCUMENT
          : p?.suggest_shipping_document_type || PREFERRED_DOCUMENT;
      };
      const withType = (r: PackageRef) => ({ shipping_document_type: typeOf(r) });

      let status = await documentResults(
        shop,
        "/api/v2/logistics/get_shipping_document_result",
        withTracking,
        withType,
      );
      const toCreate = withTracking.filter((r) => {
        const s = status.get(key(r))?.status;
        return s !== "READY" && s !== "PROCESSING";
      });
      if (toCreate.length > 0) {
        const created = await documentResults(shop, "/api/v2/logistics/create_shipping_document", toCreate, (r) => ({
          tracking_number: tracking.get(key(r))!.trackingNumber,
          ...withType(r),
        }));
        for (const r of toCreate) {
          const c = created.get(key(r));
          if (c?.fail_error) {
            out.set(key(r), {
              ref: r,
              state: "failed",
              code: c.fail_error,
              message: c.fail_message || "Shopee gagal membuat label.",
            });
          }
        }
        const again = withTracking.filter((r) => !out.has(key(r)));
        status = await documentResults(shop, "/api/v2/logistics/get_shipping_document_result", again, withType);
      }

      for (const r of withTracking) {
        if (out.has(key(r))) continue;
        const trackingNumber = tracking.get(key(r))!.trackingNumber;
        const s = status.get(key(r));
        if (s?.status === "FAILED") {
          out.set(key(r), {
            ref: r,
            state: "failed",
            code: s.fail_error || "document_failed",
            message: s.fail_message || "Shopee gagal membuat label.",
          });
          continue;
        }
        if (s?.status !== "READY") {
          out.set(key(r), { ref: r, state: "pending", trackingNumber, message: "Label sedang dibuat Shopee." });
          continue;
        }
        try {
          const pdf = await client.shopFile(shop, "POST", "/api/v2/logistics/download_shipping_document", {
            body: { ...withType(r), order_list: orderList([r]) },
          });
          out.set(
            key(r),
            isPdf(pdf)
              ? { ref: r, state: "ready", pdf, trackingNumber }
              : { ref: r, state: "failed", code: "not_pdf", message: "Shopee mengirim label bukan dalam format PDF." },
          );
        } catch (err) {
          out.set(key(r), { ref: r, state: "failed", ...asResult(err) });
        }
      }
      return refs.map((r) => out.get(key(r))!);
    },

    async tracking(
      shop: ShopCredentials,
      orders: { externalOrderId: string; externalPackageIds: string[] }[],
    ): Promise<TrackingResult[]> {
      const out: TrackingResult[] = [];
      for (const o of orders) {
        try {
          let packages = o.externalPackageIds.filter(Boolean);
          let parcels: ParcelTracking[] = [];
          if (packages.length === 0) {
            const whole = await trackOne(shop, o.externalOrderId, "");
            if (whole) parcels = [whole];
            else {
              // a split order is tracked per package (logistics.package_number_not_exist)
              const detail = (await readOrders(shop, [o.externalOrderId])).get(o.externalOrderId);
              packages = (detail?.package_list ?? []).flatMap((p) => (p.package_number ? [p.package_number] : []));
            }
          }
          for (const p of packages) {
            const parcel = await trackOne(shop, o.externalOrderId, p);
            if (parcel) parcels.push(parcel);
          }
          out.push({ externalOrderId: o.externalOrderId, parcels });
        } catch (err) {
          if (isConnectorError(err) && err.kind === "permanent") {
            out.push({
              externalOrderId: o.externalOrderId,
              error: { code: err.code, message: err.message.replace(/^[^:]+:\s*/, "") },
            });
            continue;
          }
          // busy, rate-limited, or unreachable: what was read counts, the rest waits for the next read
          if (isConnectorError(err) && err.kind === "transient" && out.length > 0) return out;
          throw err;
        }
      }
      return out;
    },
  };
}
