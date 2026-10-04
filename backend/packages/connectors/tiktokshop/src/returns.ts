import {
  fileForm,
  type NormalizedReturn,
  type NormalizedReturnItem,
  PermanentConnectorError,
  type ReturnDecision,
  type ReturnDetails,
  type ReturnEvidence,
  type ReturnKind,
  type ReturnPage,
  type ReturnResponse,
  type ReturnState,
  type ShopCredentials,
  toRupiah,
  type UploadedEvidence,
} from "@omniseller/connector-core";
import type { TiktokShopClient } from "./client.js";

/**
 * TikTok Shop after-sales APIs ("Return, refund, and cancel API overview"):
 * - Search Returns (POST /return_refund/202602/returns/search): by update time or by return ids, 50 per
 *   page with page_token
 * - Get Return Records (GET /return_refund/202309/returns/{return_id}/records): the photos and videos
 *   of the request, per role
 * - Search Cancellations (POST /return_refund/202602/cancellations/search): by order ids
 * - Get Decision Eligibility (GET /return_refund/202601/decision_eligibility): the decisions the seller
 *   may take now, with the reject reasons of each rejection; SEA shops must take reasons from here
 * - Approve Return (POST /return_refund/202309/returns/{return_id}/approve), Reject Return (POST
 *   /return_refund/202606/returns/{return_id}/reject), Approve and Reject Cancellation (POST
 *   /return_refund/202309/cancellations/{cancel_id}/approve|reject), each with an idempotency_key
 * - Upload Product Image for the photos of a rejection (the image uri is the image_id)
 *
 * A request the seller leaves unanswered is decided by TikTok Shop (48 hours for most requests). Every
 * return line item is one unit; units of one SKU are grouped here. Return lines name the SKU only.
 */
const PAGE_SIZE = 50;
const ID_BATCH = 50;
const LOCALE = "id-ID";

/** Return statuses (Search Returns, webhook 12). Unknown ones fall back to their wording. */
const RETURN_STATES: Record<string, ReturnState> = {
  RETURN_OR_REFUND_REQUEST_PENDING: "requested",
  REPLACEMENT_REQUEST_PENDING: "requested",
  EXCHANGE_REQUEST_PENDING: "requested",
  AWAITING_BUYER_RESPONSE: "negotiating",
  AWAITING_BUYER_SHIP: "accepted",
  BUYER_SHIPPED_ITEM: "in_transit",
  REFUND_OR_RETURN_REQUEST_REJECT: "rejected",
  REJECT_RECEIVE_PACKAGE: "rejected",
  REPLACEMENT_REQUEST_REJECT: "rejected",
  RETURN_OR_REFUND_REQUEST_SUCCESS: "refunded",
  RETURN_OR_REFUND_REQUEST_COMPLETE: "refunded",
  REPLACEMENT_REQUEST_REFUND_SUCCESS: "refunded",
  EXCHANGE_REQUEST_REFUND_SUCCESS: "refunded",
  RETURN_OR_REFUND_REQUEST_CANCEL: "cancelled",
  REPLACEMENT_REQUEST_CANCEL: "cancelled",
  EXCHANGE_REQUEST_CANCEL: "cancelled",
  REPLACEMENT_REQUEST_COMPLETE: "closed",
  EXCHANGE_REQUEST_COMPLETE: "closed",
};

/** Cancellation statuses; the documentation spells the closed one both CANCEL and CANCELLED. */
const CANCEL_STATES: Record<string, ReturnState> = {
  CANCELLATION_REQUEST_PENDING: "requested",
  CANCELLATION_REQUEST_SUCCESS: "accepted",
  CANCELLATION_REQUEST_COMPLETE: "refunded",
  CANCELLATION_REQUEST_CANCEL: "cancelled",
  CANCELLATION_REQUEST_CANCELLED: "cancelled",
};

const RETURN_KINDS: Record<string, ReturnKind> = {
  REFUND: "refund_only",
  RETURN_AND_REFUND: "return_refund",
  REPLACEMENT: "replacement",
  EXCHANGE: "exchange",
};

/** Decisions OmniSeller sends; others in the eligibility list (partial refunds) are left out. */
export const TIKTOK_DECISIONS: Record<string, { action: "accept" | "reject"; label: string; cancel: boolean }> = {
  APPROVE_REQUEST_CANCEL: { action: "accept", label: "Setujui pembatalan", cancel: true },
  REJECT_REQUEST_CANCEL: { action: "reject", label: "Tolak pembatalan", cancel: true },
  APPROVE_REFUND: { action: "accept", label: "Setujui pengembalian dana", cancel: false },
  APPROVE_RETURN: { action: "accept", label: "Setujui pengembalian barang", cancel: false },
  APPROVE_RECEIVED_PACKAGE: { action: "accept", label: "Barang retur sudah diterima, kembalikan dana", cancel: false },
  APPROVE_REPLACEMENT: { action: "accept", label: "Setujui penggantian barang", cancel: false },
  ISSUE_REPLACEMENT_REFUND: { action: "accept", label: "Kembalikan dana sebagai ganti penggantian", cancel: false },
  DIRECT_REFUND: { action: "accept", label: "Kembalikan dana, barang tidak perlu dikirim balik", cancel: false },
  REJECT_REFUND: { action: "reject", label: "Tolak pengembalian dana", cancel: false },
  REJECT_RETURN: { action: "reject", label: "Tolak pengembalian barang", cancel: false },
  REJECT_RECEIVED_PACKAGE: { action: "reject", label: "Tolak barang retur yang diterima", cancel: false },
  REJECT_REPLACEMENT: { action: "reject", label: "Tolak penggantian barang", cancel: false },
};

interface Amount {
  currency?: string;
  refund_total?: string;
}

interface Line {
  sku_id?: string;
  sku_name?: string;
  product_name?: string;
  seller_sku?: string;
  refund_amount?: Amount;
}

export interface TiktokReturn {
  return_id?: string;
  order_id?: string;
  return_type?: string;
  return_status?: string;
  arbitration_status?: string;
  role?: string;
  return_reason?: string;
  return_reason_text?: string;
  return_tracking_number?: string;
  return_provider_name?: string;
  can_buyer_keep_item?: boolean;
  create_time?: number;
  update_time?: number;
  seller_next_action_response?: { action?: string; deadline?: number }[];
  return_line_items?: Line[];
  refund_amount?: Amount;
}

export interface TiktokCancellation {
  cancel_id?: string;
  order_id?: string;
  cancel_type?: string;
  cancel_status?: string;
  role?: string;
  cancel_reason?: string;
  cancel_reason_text?: string;
  create_time?: number;
  update_time?: number;
  seller_next_action_response?: { action?: string; deadline?: number }[];
  refund_amount?: Amount;
  cancel_line_items?: Line[];
}

const at = (seconds: number | undefined): Date | null => (seconds && seconds > 0 ? new Date(seconds * 1000) : null);
const text = (s: string | undefined | null): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

function stateByWords(status: string): ReturnState {
  if (status.includes("CANCEL")) return "cancelled";
  if (status.includes("REJECT")) return "rejected";
  if (status.includes("SUCCESS") || status.includes("COMPLETE")) return "refunded";
  return "requested";
}

export function tiktokReturnState(status: string, arbitration?: string): ReturnState {
  if (arbitration === "IN_PROGRESS") return "disputed";
  const state = RETURN_STATES[status] ?? stateByWords(status);
  // the platform upheld the seller's rejection: nothing further happens
  return state === "rejected" && arbitration === "SUPPORT_SELLER" ? "closed" : state;
}

function initiator(role: string | undefined): NormalizedReturn["initiator"] {
  if (role === "BUYER") return "buyer";
  if (role === "SELLER") return "seller";
  if (role === "OPERATOR" || role === "SYSTEM") return "marketplace";
  return null;
}

/** The earliest deadline of the seller's next actions, and the action it belongs to. */
function nextAction(list: { action?: string; deadline?: number }[] | undefined) {
  const due = (list ?? [])
    .filter((a) => a.deadline && a.deadline > 0)
    .sort((a, b) => (a.deadline ?? 0) - (b.deadline ?? 0))[0];
  return { respondBy: at(due?.deadline), sellerAction: text(due?.action ?? list?.[0]?.action) };
}

/** Units grouped per SKU; every line item is one unit. */
function items(lines: Line[] | undefined): NormalizedReturnItem[] {
  const bySku = new Map<string, Line[]>();
  for (const l of lines ?? []) {
    const sku = l.sku_id ? String(l.sku_id) : "";
    if (sku) bySku.set(sku, [...(bySku.get(sku) ?? []), l]);
  }
  return [...bySku].map(([skuId, units]) => {
    const refunds = units.map((u) => toRupiah(u.refund_amount?.refund_total));
    return {
      externalItemId: "",
      externalVariantId: skuId,
      quantity: units.length,
      sku: text(units[0]!.seller_sku),
      title: text(units[0]!.product_name),
      refundAmount: refunds.every((r) => r === null) ? null : refunds.reduce<number>((n, r) => n + (r ?? 0), 0),
    };
  });
}

export function normalizeTiktokReturn(r: TiktokReturn): NormalizedReturn {
  const status = r.return_status ?? "UNKNOWN";
  const kind = RETURN_KINDS[r.return_type ?? ""] ?? "refund_only";
  return {
    externalReturnId: String(r.return_id),
    externalOrderId: String(r.order_id ?? ""),
    kind,
    state: tiktokReturnState(status, r.arbitration_status),
    externalStatus: r.arbitration_status === "IN_PROGRESS" ? `${status} (ARBITRATION)` : status,
    initiator: initiator(r.role),
    reasonCode: text(r.return_reason),
    reason: text(r.return_reason_text),
    evidence: [],
    refundAmount: toRupiah(r.refund_amount?.refund_total),
    currency: r.refund_amount?.currency || "IDR",
    ...nextAction(r.seller_next_action_response),
    goodsReturn: kind !== "refund_only" && r.can_buyer_keep_item !== true,
    returnTrackingNumber: text(r.return_tracking_number),
    returnCarrier: text(r.return_provider_name),
    createdAt: at(r.create_time) ?? new Date(),
    updatedAt: at(r.update_time) ?? at(r.create_time) ?? new Date(),
    items: items(r.return_line_items),
  };
}

export function normalizeTiktokCancellation(c: TiktokCancellation): NormalizedReturn {
  const status = c.cancel_status ?? "UNKNOWN";
  return {
    externalReturnId: String(c.cancel_id),
    externalOrderId: String(c.order_id ?? ""),
    kind: "cancellation",
    state: CANCEL_STATES[status] ?? stateByWords(status),
    externalStatus: status,
    initiator: initiator(c.role),
    reasonCode: text(c.cancel_reason),
    reason: text(c.cancel_reason_text),
    evidence: [],
    refundAmount: toRupiah(c.refund_amount?.refund_total),
    currency: c.refund_amount?.currency || "IDR",
    ...nextAction(c.seller_next_action_response),
    goodsReturn: false,
    returnTrackingNumber: null,
    returnCarrier: null,
    createdAt: at(c.create_time) ?? new Date(),
    updatedAt: at(c.update_time) ?? at(c.create_time) ?? new Date(),
    items: items(c.cancel_line_items),
  };
}

interface RecordsData {
  records?: {
    role?: string;
    images?: { url?: string }[];
    videos?: { url?: string; cover?: string }[];
  }[];
}

/** Photos and videos of a return's records, newest records last as TikTok Shop lists them. */
export function tiktokRecordEvidence(data: RecordsData): ReturnEvidence[] {
  const out: ReturnEvidence[] = [];
  for (const r of data.records ?? []) {
    const by = r.role === "BUYER" ? "buyer" : r.role === "SELLER" ? "seller" : "marketplace";
    for (const i of r.images ?? []) if (i.url) out.push({ type: "image", url: i.url, thumbnailUrl: null, by });
    for (const v of r.videos ?? []) {
      if (v.url) out.push({ type: "video", url: v.url, thumbnailUrl: text(v.cover), by });
    }
  }
  return out;
}

interface EligibilityData {
  decisions?: {
    decision?: string;
    eligible?: boolean;
    available_reject_reasons?: { name?: string; text?: string }[];
  }[];
}

export function tiktokDecisions(data: EligibilityData, kind: ReturnKind): ReturnDecision[] {
  const out: ReturnDecision[] = [];
  for (const d of data.decisions ?? []) {
    const known = d.decision ? TIKTOK_DECISIONS[d.decision] : undefined;
    if (!known || d.eligible !== true || known.cancel !== (kind === "cancellation")) continue;
    out.push({
      code: d.decision!,
      action: known.action,
      label: known.label,
      reasons:
        known.action === "reject"
          ? (d.available_reject_reasons ?? [])
              .filter((r) => r.name)
              .map((r) => ({ code: r.name!, label: text(r.text) ?? r.name!, evidence: [] }))
          : [],
      needsEmail: false,
    });
  }
  return out;
}

interface SearchReturnsData {
  return_orders?: TiktokReturn[];
  next_page_token?: string;
}

interface SearchCancellationsData {
  cancellations?: TiktokCancellation[];
  next_page_token?: string;
}

export function tiktokReturns(client: TiktokShopClient) {
  const searchReturns = (shop: ShopCredentials, body: object, pageToken?: string | null) =>
    client.call<SearchReturnsData>({
      method: "POST",
      path: "/return_refund/202602/returns/search",
      accessToken: shop.accessToken,
      shopCipher: shop.shopCipher,
      query: {
        page_size: String(PAGE_SIZE),
        sort_field: "update_time",
        sort_order: "ASC",
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      body: { ...body, locale: LOCALE },
    });

  const post = (shop: ShopCredentials, path: string, key: string, body: object) =>
    client.call({
      method: "POST",
      path,
      accessToken: shop.accessToken,
      shopCipher: shop.shopCipher,
      query: { idempotency_key: key },
      body,
    });

  return {
    async listReturns(
      shop: ShopCredentials,
      input: { from: Date; to: Date; cursor?: string | null },
    ): Promise<ReturnPage> {
      const data = await searchReturns(
        shop,
        {
          update_time_ge: Math.floor(input.from.getTime() / 1000),
          update_time_lt: Math.floor(input.to.getTime() / 1000),
        },
        input.cursor,
      );
      return {
        returns: (data.return_orders ?? []).filter((r) => r.return_id).map(normalizeTiktokReturn),
        nextCursor: data.next_page_token || null,
      };
    },

    async getReturns(shop: ShopCredentials, externalReturnIds: string[]): Promise<NormalizedReturn[]> {
      const ids = [...new Set(externalReturnIds.filter(Boolean))];
      const out: NormalizedReturn[] = [];
      for (let i = 0; i < ids.length; i += ID_BATCH) {
        let token: string | null = null;
        do {
          const data: SearchReturnsData = await searchReturns(shop, { return_ids: ids.slice(i, i + ID_BATCH) }, token);
          for (const r of data.return_orders ?? []) if (r.return_id) out.push(normalizeTiktokReturn(r));
          token = data.next_page_token || null;
        } while (token);
      }
      return out;
    },

    async cancellations(shop: ShopCredentials, externalOrderIds: string[]): Promise<NormalizedReturn[]> {
      const ids = [...new Set(externalOrderIds.filter(Boolean))];
      const out: NormalizedReturn[] = [];
      for (let i = 0; i < ids.length; i += ID_BATCH) {
        let token: string | null = null;
        do {
          const data: SearchCancellationsData = await client.call<SearchCancellationsData>({
            method: "POST",
            path: "/return_refund/202602/cancellations/search",
            accessToken: shop.accessToken,
            shopCipher: shop.shopCipher,
            query: {
              page_size: String(PAGE_SIZE),
              sort_field: "update_time",
              sort_order: "ASC",
              ...(token ? { page_token: token } : {}),
            },
            // seller and system cancellations are not requests to answer
            body: { order_ids: ids.slice(i, i + ID_BATCH), cancel_types: ["BUYER_CANCEL"], locale: LOCALE },
          });
          for (const c of data.cancellations ?? []) {
            if (c.cancel_id && c.cancel_type !== "CANCEL") out.push(normalizeTiktokCancellation(c));
          }
          token = data.next_page_token || null;
        } while (token);
      }
      return out;
    },

    async details(
      shop: ShopCredentials,
      request: Pick<NormalizedReturn, "externalReturnId" | "kind">,
    ): Promise<ReturnDetails> {
      const eligibility = await client.call<EligibilityData>({
        method: "GET",
        path: "/return_refund/202601/decision_eligibility",
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
        query: { return_or_cancel_id: request.externalReturnId, locale: LOCALE },
      });
      if (request.kind === "cancellation")
        return { decisions: tiktokDecisions(eligibility, request.kind), evidence: null };
      const records = await client.call<RecordsData>({
        method: "GET",
        path: `/return_refund/202309/returns/${encodeURIComponent(request.externalReturnId)}/records`,
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
        query: { locale: LOCALE },
      });
      return { decisions: tiktokDecisions(eligibility, request.kind), evidence: tiktokRecordEvidence(records) };
    },

    async uploadEvidence(
      shop: ShopCredentials,
      input: { bytes: Uint8Array; contentType: string },
    ): Promise<UploadedEvidence> {
      const ext = input.contentType === "image/png" ? "png" : "jpg";
      const data = await client.upload<{ uri?: string; width?: number; height?: number }>({
        path: "/product/202309/images/upload",
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
        // a supporting picture, kept as it is (main and variant images are cropped to 1:1)
        form: fileForm(
          { field: "data", bytes: input.bytes, contentType: input.contentType, filename: `evidence.${ext}` },
          { use_case: "DESCRIPTION_IMAGE" },
        ),
      });
      if (!data.uri) throw new PermanentConnectorError({ code: "no_image_uri", message: "upload returned no image" });
      return { ref: data.uri, contentType: input.contentType, width: data.width ?? null, height: data.height ?? null };
    },

    async respond(shop: ShopCredentials, r: ReturnResponse): Promise<void> {
      const known = TIKTOK_DECISIONS[r.decision];
      if (!known || known.cancel !== (r.kind === "cancellation")) {
        throw new PermanentConnectorError({
          code: "unknown_decision",
          message: `decision ${r.decision} is not supported`,
        });
      }
      const id = encodeURIComponent(r.externalReturnId);
      const images = r.evidence.map((e) => ({
        image_id: e.ref,
        mime_type: e.contentType,
        ...(e.width ? { width: e.width } : {}),
        ...(e.height ? { height: e.height } : {}),
      }));
      const rejection = {
        reject_reason: r.reason ?? "",
        ...(r.comment ? { comment: r.comment } : {}),
        ...(images.length ? { images } : {}),
      };
      if (known.action === "reject" && !r.reason) {
        throw new PermanentConnectorError({ code: "reason_required", message: "a rejection needs a reason" });
      }
      if (r.kind === "cancellation") {
        const path = `/return_refund/202309/cancellations/${id}/${known.action === "accept" ? "approve" : "reject"}`;
        await post(shop, path, r.idempotencyKey, known.action === "accept" ? {} : rejection);
        return;
      }
      if (known.action === "accept") {
        await post(shop, `/return_refund/202309/returns/${id}/approve`, r.idempotencyKey, { decision: r.decision });
        return;
      }
      await post(shop, `/return_refund/202606/returns/${id}/reject`, r.idempotencyKey, {
        decision: r.decision,
        ...rejection,
      });
    },
  };
}
