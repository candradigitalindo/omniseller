import {
  fileForm,
  type NormalizedOrder,
  type NormalizedReturn,
  type NormalizedReturnItem,
  PermanentConnectorError,
  type ReturnDecision,
  type ReturnDetails,
  type ReturnEvidence,
  type ReturnPage,
  type ReturnRejectReason,
  type ReturnResponse,
  type ReturnState,
  type ShopCredentials,
  toRupiah,
  type UploadedEvidence,
} from "@omniseller/connector-core";
import type { ShopeeClient } from "./client.js";
import { shopeeOrders } from "./orders.js";

/**
 * Shopee after-sales APIs (v2.returns, v2.order.handle_buyer_cancellation):
 * - get_return_list: returns by update time, at most 15 days per request, 100 per page (page_no)
 * - get_return_detail: one return, with the buyer's videos
 * - confirm: the seller agrees to refund
 * - dispute: the seller disputes with a reason id from get_return_dispute_reason, the evidence each
 *   of its modules asks for (photos converted with convert_image), and a contact email
 * - handle_buyer_cancellation: ACCEPT or REJECT a buyer's cancellation request. Shopee has no
 *   cancellation id or list: the request is the order in IN_CANCEL, read with get_order_detail.
 *
 * Statuses (Data Definition, ReturnStatus): REQUESTED, ACCEPTED (the buyer sends the items back, the
 * seller may still dispute), PROCESSING, SELLER_DISPUTE and JUDGING (Shopee decides), CANCELLED,
 * CLOSED. Shopee sends no push for returns; the order's push says TO_RETURN when one starts. The buyer's
 * email and pickup address that come with a return are never read.
 */
const WINDOW_SECONDS = 15 * 86_400 - 60;
const PAGE_SIZE = 100;

/** Dispute reasons (Data Definition, ReturnDisputeReasonId) in Indonesian; others show their id. */
const DISPUTE_REASONS: Record<string, string> = {
  "1": "Saya menolak klaim barang tidak diterima",
  "2": "Saya menolak permintaan pengembalian",
  "3": "Saya menyetujui pengembalian, tetapi barang retur tidak saya terima",
  "9": "Barang sudah saya kirim dan ada bukti pengiriman",
  "10": "Barang yang saya kirim sesuai pesanan pembeli",
  "11": "Barang yang saya kirim berfungsi dengan baik",
  "12": "Saya menyetujui pengembalian, tetapi barang retur belum saya terima",
  "13": "Saya menyetujui pengembalian, tetapi barang retur salah atau rusak",
  "41": "Barang sudah saya kirim dan ada bukti pengiriman",
  "42": "Barang yang saya kirim sesuai pesanan pembeli",
  "43": "Barang yang saya kirim berfungsi dengan baik",
  "44": "Tidak tercapai kesepakatan dengan pembeli",
  "45": "Produk tidak dalam masa garansi pengembalian",
  "46": "Barang retur tidak diterima",
  "47": "Barang retur diterima dalam keadaan rusak fisik",
  "48": "Barang retur tidak lengkap (jumlah atau aksesori kurang)",
  "49": "Barang retur yang diterima salah",
  "50": "Barang retur diterima, klaim pembeli tidak benar",
  "53": "Klaim pembeli tidak benar",
  "54": "Jumlah pengembalian dana ke pembeli salah",
  "55": "Klaim pembeli benar, tetapi ada keberatan lain",
  "56": "Barang retur diterima dalam keadaan sudah dipakai",
  "81": "Barang retur tidak diterima",
  "82": "Barang retur diterima dalam keadaan rusak fisik",
  "83": "Barang retur tidak lengkap (jumlah atau aksesori kurang)",
  "84": "Barang retur yang diterima salah",
  "85": "Produk tidak dalam masa garansi pengembalian",
  "86": "Barang retur diterima, klaim pembeli tidak benar",
  "88": "Pembeli tidak menanggapi pengembalian yang diatur penjual",
  "89": "Barang retur diterima dalam keadaan sudah dipakai",
};

/** Statuses in which the seller may still dispute (v2.returns.dispute) or confirm the refund. */
const DISPUTABLE = new Set(["REQUESTED", "PROCESSING", "ACCEPTED"]);
const CONFIRMABLE = new Set(["REQUESTED", "PROCESSING"]);

export interface ShopeeReturn {
  return_sn?: string;
  order_sn?: string;
  status?: string;
  reason?: string;
  text_reason?: string;
  image?: string[];
  buyer_videos?: { thumbnail_url?: string; video_url?: string }[];
  refund_amount?: number | string;
  currency?: string;
  create_time?: number;
  update_time?: number;
  due_date?: number;
  return_seller_due_date?: number;
  tracking_number?: string;
  needs_logistics?: boolean;
  return_solution?: number;
  negotiation_status?: string;
  negotiation?: { negotiation_status?: string };
  reverse_logistics_channel_name?: string;
  item?: {
    item_id?: number | string;
    model_id?: number | string;
    name?: string;
    amount?: number;
    item_sku?: string;
    variation_sku?: string;
    refund_amount?: number | string;
  }[];
}

const at = (seconds: number | undefined): Date | null => (seconds && seconds > 0 ? new Date(seconds * 1000) : null);
const text = (s: string | undefined | null): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

export function shopeeReturnState(r: ShopeeReturn): ReturnState {
  const negotiation = r.negotiation_status ?? r.negotiation?.negotiation_status;
  const goods = r.needs_logistics === true;
  switch (r.status) {
    case "REQUESTED":
      return negotiation === "PENDING_BUYER_RESPOND" ? "negotiating" : "requested";
    case "ACCEPTED":
      // nothing to send back: accepting is the refund
      if (!goods) return "refunded";
      return text(r.tracking_number) ? "in_transit" : "accepted";
    case "PROCESSING":
      return goods && text(r.tracking_number) ? "in_transit" : "accepted";
    case "SELLER_DISPUTE":
    case "JUDGING":
      return "disputed";
    case "CANCELLED":
      return "cancelled";
    case "CLOSED":
      return "closed";
    default:
      return "requested";
  }
}

function returnItems(r: ShopeeReturn): NormalizedReturnItem[] {
  return (r.item ?? [])
    .filter((i) => i.item_id !== undefined && (i.amount ?? 0) > 0)
    .map((i) => ({
      externalItemId: String(i.item_id),
      externalVariantId: i.model_id !== undefined && String(i.model_id) !== "0" ? String(i.model_id) : "",
      quantity: i.amount ?? 0,
      sku: text(i.variation_sku) ?? text(i.item_sku),
      title: text(i.name),
      refundAmount: toRupiah(i.refund_amount),
    }));
}

function returnEvidence(r: ShopeeReturn): ReturnEvidence[] {
  return [
    ...(r.image ?? [])
      .filter(Boolean)
      .map((url) => ({ type: "image" as const, url, thumbnailUrl: null, by: "buyer" as const })),
    ...(r.buyer_videos ?? [])
      .filter((v) => v.video_url)
      .map((v) => ({
        type: "video" as const,
        url: v.video_url!,
        thumbnailUrl: text(v.thumbnail_url),
        by: "buyer" as const,
      })),
  ];
}

export function normalizeShopeeReturn(r: ShopeeReturn): NormalizedReturn {
  const status = r.status ?? "UNKNOWN";
  const goods = r.needs_logistics === true;
  // 0: return and refund, 1: refund only (the latest solution, not the one under negotiation)
  const kind =
    r.return_solution === 1 ? "refund_only" : r.return_solution === 0 || goods ? "return_refund" : "refund_only";
  const respondBy =
    status === "REQUESTED"
      ? at(r.due_date)
      : CONFIRMABLE.has(status) || status === "ACCEPTED"
        ? at(r.return_seller_due_date)
        : null;
  return {
    externalReturnId: String(r.return_sn),
    externalOrderId: String(r.order_sn ?? ""),
    kind,
    state: shopeeReturnState(r),
    externalStatus: status,
    initiator: "buyer",
    reasonCode: text(r.reason),
    reason: text(r.text_reason),
    evidence: returnEvidence(r),
    refundAmount: toRupiah(r.refund_amount),
    currency: r.currency || "IDR",
    respondBy,
    sellerAction: null,
    goodsReturn: kind === "return_refund",
    returnTrackingNumber: text(r.tracking_number),
    returnCarrier: text(r.reverse_logistics_channel_name),
    createdAt: at(r.create_time) ?? new Date(),
    updatedAt: at(r.update_time) ?? at(r.create_time) ?? new Date(),
    items: returnItems(r),
  };
}

/**
 * A buyer's cancellation request as Shopee keeps it: the order in IN_CANCEL. Once the order leaves
 * IN_CANCEL the request is over: accepted when the order was cancelled, closed when it goes on.
 */
export function shopeeCancellationOf(o: NormalizedOrder): NormalizedReturn {
  const state: ReturnState =
    o.externalStatus === "IN_CANCEL" ? "requested" : o.externalStatus === "CANCELLED" ? "accepted" : "closed";
  return {
    externalReturnId: o.externalOrderId,
    externalOrderId: o.externalOrderId,
    kind: "cancellation",
    state,
    externalStatus: o.externalStatus,
    initiator: "buyer",
    reasonCode: null,
    reason: o.cancelReason,
    evidence: [],
    refundAmount: o.total,
    currency: o.currency,
    respondBy: null,
    sellerAction: null,
    goodsReturn: false,
    returnTrackingNumber: null,
    returnCarrier: null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    items: o.items
      .filter((i) => i.quantity - i.cancelledQuantity > 0)
      .map((i) => ({
        externalItemId: i.externalItemId,
        externalVariantId: i.externalVariantId,
        quantity: i.quantity - i.cancelledQuantity,
        sku: i.sku,
        title: i.title,
        refundAmount: i.lineTotal,
      })),
  };
}

interface DisputeReasonData {
  response?: {
    dispute_reason_list?: {
      dispute_reason?: string | number;
      dispute_requirement?: string;
      evidence_module_list?: { module_index?: number; requirement?: string; is_required?: boolean }[];
    }[];
  };
}

export function shopeeDisputeReasons(data: DisputeReasonData): ReturnRejectReason[] {
  return (data.response?.dispute_reason_list ?? [])
    .filter((r) => r.dispute_reason !== undefined && r.dispute_reason !== null && String(r.dispute_reason) !== "")
    .map((r) => {
      const code = String(r.dispute_reason);
      return {
        code,
        label: DISPUTE_REASONS[code] ?? `Alasan ${code}`,
        evidence: (r.evidence_module_list ?? [])
          .filter((m) => m.module_index !== undefined)
          .map((m) => ({
            module: m.module_index!,
            requirement: m.requirement ?? "",
            required: m.is_required === true,
          })),
      };
    });
}

interface ListData {
  response?: { return?: ShopeeReturn[]; more?: boolean };
}

/** Position in a long range: the start of the current 15-day window and the page inside it. */
interface Position {
  f: number;
  p: number;
}

export function shopeeReturns(client: ShopeeClient) {
  const orders = shopeeOrders(client);

  const detail = async (shop: ShopCredentials, returnSn: string) => {
    const res = await client.shopCall<{ response?: ShopeeReturn }>(shop, "GET", "/api/v2/returns/get_return_detail", {
      query: { return_sn: returnSn },
    });
    return res.response?.return_sn ? res.response : null;
  };

  const disputeReasons = async (shop: ShopCredentials, returnSn: string) =>
    shopeeDisputeReasons(
      await client.shopCall<DisputeReasonData>(shop, "GET", "/api/v2/returns/get_return_dispute_reason", {
        query: { return_sn: returnSn },
      }),
    );

  return {
    async listReturns(
      shop: ShopCredentials,
      input: { from: Date; to: Date; cursor?: string | null },
    ): Promise<ReturnPage> {
      const toSec = Math.floor(input.to.getTime() / 1000);
      const pos: Position = input.cursor
        ? (JSON.parse(input.cursor) as Position)
        : { f: Math.floor(input.from.getTime() / 1000), p: 0 };
      if (pos.f >= toSec) return { returns: [], nextCursor: null };
      const windowTo = Math.min(pos.f + WINDOW_SECONDS, toSec);
      const res = await client.shopCall<ListData>(shop, "GET", "/api/v2/returns/get_return_list", {
        query: {
          page_no: String(pos.p),
          page_size: String(PAGE_SIZE),
          update_time_from: String(pos.f),
          update_time_to: String(windowTo),
        },
      });
      const next: Position | null = res.response?.more
        ? { f: pos.f, p: pos.p + 1 }
        : windowTo < toSec
          ? { f: windowTo, p: 0 }
          : null;
      return {
        returns: (res.response?.return ?? []).filter((r) => r.return_sn).map(normalizeShopeeReturn),
        nextCursor: next ? JSON.stringify(next) : null,
      };
    },

    async getReturns(shop: ShopCredentials, externalReturnIds: string[]): Promise<NormalizedReturn[]> {
      const out: NormalizedReturn[] = [];
      for (const sn of [...new Set(externalReturnIds.filter(Boolean))]) {
        const r = await detail(shop, sn);
        if (r) out.push(normalizeShopeeReturn(r));
      }
      return out;
    },

    async cancellations(shop: ShopCredentials, externalOrderIds: string[]): Promise<NormalizedReturn[]> {
      return (await orders.getOrders(shop, externalOrderIds)).map(shopeeCancellationOf);
    },

    async details(
      shop: ShopCredentials,
      request: Pick<NormalizedReturn, "externalReturnId" | "kind" | "externalStatus">,
    ): Promise<ReturnDetails> {
      if (request.kind === "cancellation") {
        const open = request.externalStatus === "IN_CANCEL";
        const decisions: ReturnDecision[] = open
          ? [
              { code: "ACCEPT", action: "accept", label: "Setujui pembatalan", reasons: [], needsEmail: false },
              { code: "REJECT", action: "reject", label: "Tolak pembatalan", reasons: [], needsEmail: false },
            ]
          : [];
        return { decisions, evidence: null };
      }
      const current = await detail(shop, request.externalReturnId);
      const status = current?.status ?? request.externalStatus;
      const decisions: ReturnDecision[] = [];
      if (CONFIRMABLE.has(status)) {
        decisions.push({
          code: "confirm",
          action: "accept",
          label: "Setujui pengembalian dana",
          reasons: [],
          needsEmail: false,
        });
      }
      if (DISPUTABLE.has(status)) {
        const reasons = await disputeReasons(shop, request.externalReturnId);
        if (reasons.length > 0) {
          decisions.push({
            code: "dispute",
            action: "reject",
            label: "Ajukan sanggahan ke Shopee",
            reasons,
            needsEmail: true,
          });
        }
      }
      return { decisions, evidence: current ? returnEvidence(current) : null };
    },

    async uploadEvidence(
      shop: ShopCredentials,
      input: { externalReturnId: string; bytes: Uint8Array; contentType: string },
    ): Promise<UploadedEvidence> {
      const ext = input.contentType === "image/png" ? "png" : "jpg";
      const res = await client.shopUpload<{ response?: { url?: string } }>(
        shop,
        "/api/v2/returns/convert_image",
        fileForm(
          { field: "upload_image", bytes: input.bytes, contentType: input.contentType, filename: `evidence.${ext}` },
          { return_sn: input.externalReturnId },
        ),
      );
      const url = res.response?.url;
      if (!url) throw new PermanentConnectorError({ code: "no_image_url", message: "convert_image returned no url" });
      return { ref: url, contentType: input.contentType, width: null, height: null };
    },

    async respond(shop: ShopCredentials, r: ReturnResponse): Promise<void> {
      if (r.kind === "cancellation") {
        if (r.decision !== "ACCEPT" && r.decision !== "REJECT") {
          throw new PermanentConnectorError({
            code: "unknown_decision",
            message: `decision ${r.decision} is not supported`,
          });
        }
        await client.shopCall(shop, "POST", "/api/v2/order/handle_buyer_cancellation", {
          body: { order_sn: r.externalOrderId, operation: r.decision },
        });
        return;
      }
      if (r.decision === "confirm") {
        await client.shopCall(shop, "POST", "/api/v2/returns/confirm", { body: { return_sn: r.externalReturnId } });
        return;
      }
      if (r.decision !== "dispute") {
        throw new PermanentConnectorError({
          code: "unknown_decision",
          message: `decision ${r.decision} is not supported`,
        });
      }
      if (!r.reason || !r.email) {
        throw new PermanentConnectorError({
          code: "dispute_incomplete",
          message: "a dispute needs a reason and an email",
        });
      }
      // the requirement text goes back exactly as Shopee wrote it
      const reason = (await disputeReasons(shop, r.externalReturnId)).find((x) => x.code === r.reason);
      if (!reason) {
        throw new PermanentConnectorError({
          code: "reason_unavailable",
          message: "the dispute reason is no longer offered",
        });
      }
      const imageList = reason.evidence
        .map((m) => ({
          module_index: m.module,
          requirement: m.requirement,
          image_url: r.evidence.filter((e) => e.module === m.module).map((e) => e.ref),
        }))
        .filter((m) => m.image_url.length > 0);
      await client.shopCall(shop, "POST", "/api/v2/returns/dispute", {
        body: {
          return_sn: r.externalReturnId,
          email: r.email,
          dispute_reason_id: Number(r.reason),
          ...(r.comment ? { dispute_text_reason: r.comment } : {}),
          ...(imageList.length ? { image_list: imageList } : {}),
        },
      });
    },
  };
}
