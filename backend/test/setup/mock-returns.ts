import { randomBytes } from "node:crypto";
import type { MockShopeeShop, MockTiktokShop } from "./mock-marketplace";
import { sniffImage } from "./mock-products";

/**
 * After-sales APIs of the fake marketplaces (backend doc 8.26, 13.2), enforcing what the documentation
 * says:
 *
 * Shopee (v2.returns): get_return_list by update time, at most 15 days and 100 per page; confirm and
 * dispute only in the statuses Shopee allows; a dispute needs an email, a reason id from
 * get_return_dispute_reason, and a photo (from convert_image) for every required evidence module;
 * handle_buyer_cancellation only for an order in IN_CANCEL. The buyer's email and pickup address come
 * with every return, so tests can prove OmniSeller never keeps them.
 * TikTok Shop: Search Returns (page_size 10 to 50) and Search Cancellations, Get Decision Eligibility
 * from the request's status, approve and reject only eligible decisions with a reason from the list and
 * images uploaded through Upload Product Image, and an idempotency key that answers a repeated decision
 * without applying it twice.
 */

const now = () => Math.floor(Date.now() / 1000);
/** A change moves the update time forward, never back, like the marketplaces' own clocks. */
const later = (t: number) => Math.max(t + 1, now());

export interface MockShopeeReturn {
  return_sn: string;
  order_sn: string;
  status: "REQUESTED" | "ACCEPTED" | "CANCELLED" | "JUDGING" | "CLOSED" | "PROCESSING" | "SELLER_DISPUTE";
  reason?: string;
  text_reason?: string;
  image?: string[];
  buyer_videos?: { thumbnail_url: string; video_url: string }[];
  refund_amount?: number;
  currency?: string;
  create_time: number;
  update_time: number;
  due_date?: number;
  return_seller_due_date?: number;
  tracking_number?: string;
  needs_logistics: boolean;
  return_solution: 0 | 1;
  negotiation_status?: string;
  item: {
    item_id: number;
    model_id: number;
    name: string;
    amount: number;
    item_sku?: string;
    variation_sku?: string;
    refund_amount?: number;
  }[];
  /** What get_return_dispute_reason lists; defaults to a damaged item (two modules) and no agreement. */
  disputeReasons?: {
    dispute_reason: string;
    dispute_requirement?: string;
    evidence_module_list?: { module_index: number; requirement: string; is_required: boolean }[];
  }[];
}

export interface MockTiktokReturn {
  return_id: string;
  order_id: string;
  return_type: "REFUND" | "RETURN_AND_REFUND" | "REPLACEMENT" | "EXCHANGE";
  return_status: string;
  arbitration_status?: string;
  role?: string;
  return_reason?: string;
  return_reason_text?: string;
  return_tracking_number?: string;
  can_buyer_keep_item?: boolean;
  create_time: number;
  update_time: number;
  seller_next_action_response?: { action: string; deadline: number }[];
  return_line_items: {
    return_line_item_id: string;
    sku_id: string;
    seller_sku?: string;
    product_name?: string;
    refund_amount?: { currency: string; refund_total: string };
  }[];
  refund_amount?: { currency: string; refund_total: string };
  records?: { role: string; images?: { url: string }[]; videos?: { url: string; cover?: string }[] }[];
}

export interface MockTiktokCancellation {
  cancel_id: string;
  order_id: string;
  cancel_type: "CANCEL" | "BUYER_CANCEL";
  cancel_status: string;
  role?: string;
  cancel_reason?: string;
  cancel_reason_text?: string;
  create_time: number;
  update_time: number;
  seller_next_action_response?: { action: string; deadline: number }[];
  cancel_line_items: { cancel_line_item_id: string; sku_id: string; seller_sku?: string; product_name?: string }[];
  refund_amount?: { currency: string; refund_total: string };
}

export const TIKTOK_REJECT_REASONS = [
  { name: "seller_reject_apply_product_has_been_packed", text: "Produk sudah dikemas" },
  { name: "seller_reject_receive_package_damaged", text: "Barang retur rusak" },
];

const SHOPEE_DEFAULT_DISPUTE = [
  {
    dispute_reason: "47",
    dispute_requirement: "Kirim bukti untuk sanggahan.",
    evidence_module_list: [
      { module_index: 1, requirement: "Foto atau video membuka paket retur dengan resi.", is_required: true },
      { module_index: 2, requirement: "Foto barang retur.", is_required: false },
    ],
  },
  { dispute_reason: "44", dispute_requirement: "", evidence_module_list: [] },
];

export class MockReturnState {
  /** Shopee returns per shop id. */
  readonly shopee = new Map<string, MockShopeeReturn[]>();
  /** TikTok Shop returns and cancellations per shop cipher. */
  readonly tiktokReturns = new Map<string, MockTiktokReturn[]>();
  readonly tiktokCancellations = new Map<string, MockTiktokCancellation[]>();
  /** URLs convert_image handed out. */
  readonly shopeeProofs = new Set<string>();
  /** Decisions applied, in order: `<marketplace>:<request id>:<decision>`. */
  readonly decisions: string[] = [];
  /** Shopee dispute bodies as received. */
  readonly disputes: Record<string, unknown>[] = [];
  /** TikTok Shop rejection bodies as received. */
  readonly rejections: Record<string, unknown>[] = [];
  /** TikTok Shop idempotency keys already used, with the request they answered. */
  readonly tiktokKeys = new Map<string, string>();
}

type Reply = { status: number; body: unknown };
interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
  form?: FormData;
}

const parse = (body: string) => (body ? (JSON.parse(body) as Record<string, unknown>) : {});

// ---- Shopee ----

export async function shopeeReturnCall(
  state: MockReturnState,
  call: Call,
  shop: MockShopeeShop,
  ok: (extra: object) => Reply,
  fail: (error: string, message: string, status?: number) => Reply,
  proofUrl: (id: string) => string,
): Promise<Reply | null> {
  const q = call.query;
  const returns = state.shopee.get(shop.shopId) ?? [];
  const find = (sn: unknown) => returns.find((r) => r.return_sn === sn);
  const withPii = (r: MockShopeeReturn) => ({
    ...r,
    disputeReasons: undefined,
    user: { username: "pembeli_rahasia", email: "pembeli.rahasia@example.com", portrait: "https://cf/p" },
    return_pickup_address: { name: "Budi Rahasia", phone: "6281299990000", address: "Jl. Rahasia No. 1" },
  });
  switch (`${call.method} ${call.path}`) {
    case "GET /api/v2/returns/get_return_list": {
      const page = Number(q.page_no);
      const size = Number(q.page_size);
      if (!(page >= 0) || !(size >= 1 && size <= 100))
        return fail("error_param", "page_no and page_size are required.", 400);
      const from = Number(q.update_time_from);
      const to = Number(q.update_time_to);
      if (!(to > from) || to - from > 15 * 86_400) {
        return fail(
          "error_param",
          "The period between update_time_from and update_time_to must not more than 15 days.",
          400,
        );
      }
      const all = returns
        .filter((r) => r.update_time >= from && r.update_time <= to)
        .sort((a, b) => a.update_time - b.update_time);
      const slice = all.slice(page * size, (page + 1) * size);
      return ok({ response: { more: (page + 1) * size < all.length, return: slice.map(withPii) } });
    }
    case "GET /api/v2/returns/get_return_detail": {
      const r = find(q.return_sn);
      if (!r) return fail("error_not_found", "return_sn not found", 200);
      return ok({ response: withPii(r) });
    }
    case "GET /api/v2/returns/get_return_dispute_reason": {
      const r = find(q.return_sn);
      if (!r) return fail("error_not_found", "return_sn not found", 200);
      return ok({ response: { dispute_reason_list: r.disputeReasons ?? SHOPEE_DEFAULT_DISPUTE } });
    }
    case "POST /api/v2/returns/convert_image": {
      const file = call.form?.get("upload_image");
      const sn = call.form?.get("return_sn");
      if (!file || typeof file === "string" || !find(sn))
        return fail("error_param", "return_sn and upload_image are required.", 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const type = sniffImage(bytes);
      if (bytes.length > 10 * 1024 * 1024 || (type !== "jpeg" && type !== "png")) {
        return fail("error_param", "Only .jpg, .jpeg and .png within 10MB are supported.", 400);
      }
      const url = proofUrl(randomBytes(8).toString("hex"));
      state.shopeeProofs.add(url);
      return ok({ response: { url, thumbnail: url } });
    }
    case "POST /api/v2/returns/confirm": {
      const body = parse(call.body);
      const r = find(body.return_sn);
      if (!r) return fail("error_not_found", "return_sn not found", 200);
      if (r.status !== "REQUESTED" && r.status !== "PROCESSING") {
        return fail("error_return_status", `Cannot confirm a return in ${r.status}.`, 200);
      }
      r.status = "ACCEPTED";
      r.update_time = later(r.update_time);
      state.decisions.push(`shopee:${r.return_sn}:confirm`);
      return ok({ response: { return_sn: r.return_sn } });
    }
    case "POST /api/v2/returns/dispute": {
      const body = parse(call.body) as {
        return_sn?: string;
        email?: string;
        dispute_reason_id?: unknown;
        dispute_text_reason?: string;
        image_list?: { module_index: number; requirement: string; image_url: string[] }[];
      };
      const r = find(body.return_sn);
      if (!r) return fail("error_not_found", "return_sn not found", 200);
      if (!["REQUESTED", "PROCESSING", "ACCEPTED"].includes(r.status)) {
        return fail(
          "error_return_status",
          "Cannot raise dispute because return SN is not in REQUESTED, RETURN_PROCESSING, or RETURN_ACCEPTED",
          200,
        );
      }
      if (!body.email)
        return fail(
          "dispute.request.param.error",
          "Key: 'email' Error:Field validation for 'email' failed on the 'required' tag",
          400,
        );
      if (typeof body.dispute_reason_id !== "number") {
        return fail(
          "dispute.request.param.error",
          "Key: 'dispute_reason_id' Error:Field validation for 'dispute_reason_id' failed",
          400,
        );
      }
      const reason = (r.disputeReasons ?? SHOPEE_DEFAULT_DISPUTE).find(
        (x) => x.dispute_reason === String(body.dispute_reason_id),
      );
      if (!reason) return fail("error_param", "Invalid dispute_reason_id for this return.", 400);
      for (const m of reason.evidence_module_list ?? []) {
        const given = (body.image_list ?? []).find((x) => x.module_index === m.module_index);
        if (given && given.requirement !== m.requirement)
          return fail("error_param", "requirement does not match the module.", 400);
        if (m.is_required && !given?.image_url?.length) return fail("error_param", "All images download fail", 400);
        if (given?.image_url.some((u) => !state.shopeeProofs.has(u)))
          return fail("error_param", "All images download fail", 400);
      }
      r.status = "SELLER_DISPUTE";
      r.update_time = later(r.update_time);
      state.disputes.push(body);
      state.decisions.push(`shopee:${r.return_sn}:dispute`);
      return ok({ response: { return_sn: r.return_sn, msg: "dispute return success" } });
    }
    case "POST /api/v2/order/handle_buyer_cancellation": {
      const body = parse(call.body) as { order_sn?: string; operation?: string };
      const o = (shop.orders ?? []).find((x) => x.order_sn === body.order_sn);
      if (!o) return fail("error_not_found", "order not found", 200);
      if (o.order_status !== "IN_CANCEL") return fail("error_param", "The order has no cancellation to handle.", 200);
      if (body.operation !== "ACCEPT" && body.operation !== "REJECT")
        return fail("error_param", "operation should be ACCEPT or REJECT", 400);
      o.order_status = body.operation === "ACCEPT" ? "CANCELLED" : "READY_TO_SHIP";
      if (body.operation === "ACCEPT") o.cancel_by = "buyer";
      o.update_time = later(o.update_time);
      state.decisions.push(`shopee:${o.order_sn}:${body.operation}`);
      return ok({ response: { update_time: o.update_time } });
    }
    default:
      return null;
  }
}

// ---- TikTok Shop ----

type TiktokReply = (code: number, message: string, data?: unknown) => Reply;

/** Decisions TikTok Shop allows for a request in its current status. */
function eligible(kind: "return" | "cancel", type: string, status: string): string[] {
  if (kind === "cancel")
    return status === "CANCELLATION_REQUEST_PENDING" ? ["APPROVE_REQUEST_CANCEL", "REJECT_REQUEST_CANCEL"] : [];
  if (status === "RETURN_OR_REFUND_REQUEST_PENDING") {
    return type === "REFUND"
      ? ["APPROVE_REFUND", "REJECT_REFUND"]
      : ["APPROVE_RETURN", "DIRECT_REFUND", "REJECT_RETURN"];
  }
  if (status === "BUYER_SHIPPED_ITEM") return ["APPROVE_RECEIVED_PACKAGE", "REJECT_RECEIVED_PACKAGE"];
  return [];
}

const APPROVED_STATUS: Record<string, string> = {
  APPROVE_RETURN: "AWAITING_BUYER_SHIP",
  APPROVE_REFUND: "RETURN_OR_REFUND_REQUEST_SUCCESS",
  DIRECT_REFUND: "RETURN_OR_REFUND_REQUEST_SUCCESS",
  APPROVE_RECEIVED_PACKAGE: "RETURN_OR_REFUND_REQUEST_SUCCESS",
};
const REJECTED_STATUS: Record<string, string> = {
  REJECT_RETURN: "REFUND_OR_RETURN_REQUEST_REJECT",
  REJECT_REFUND: "REFUND_OR_RETURN_REQUEST_REJECT",
  REJECT_RECEIVED_PACKAGE: "REJECT_RECEIVE_PACKAGE",
};

const ALL_DECISIONS = [
  "APPROVE_REQUEST_CANCEL",
  "APPROVE_REFUND",
  "APPROVE_RETURN",
  "APPROVE_RECEIVED_PACKAGE",
  "APPROVE_REPLACEMENT",
  "ISSUE_REPLACEMENT_REFUND",
  "DIRECT_REFUND",
  "REJECT_REQUEST_CANCEL",
  "REJECT_REFUND",
  "REJECT_RETURN",
  "REJECT_RECEIVED_PACKAGE",
  "REJECT_REPLACEMENT",
];

function page<T>(all: T[], q: Record<string, string>) {
  const offset = Number(q.page_token ? Buffer.from(q.page_token, "base64url").toString() : 0);
  const size = Number(q.page_size ?? 10);
  const slice = all.slice(offset, offset + size);
  const next = offset + size < all.length ? Buffer.from(String(offset + size)).toString("base64url") : "";
  return { slice, next, total: all.length };
}

export function tiktokReturnCall(
  state: MockReturnState,
  call: Call,
  shop: MockTiktokShop,
  reply: TiktokReply,
  uploadedImages: ReadonlyMap<string, string>,
): Reply | null {
  const q = call.query;
  const returns = state.tiktokReturns.get(shop.cipher) ?? [];
  const cancellations = state.tiktokCancellations.get(shop.cipher) ?? [];
  const key = `${call.method} ${call.path}`;

  if (key === "POST /return_refund/202602/returns/search") {
    const size = Number(q.page_size ?? 10);
    if (!(size >= 10 && size <= 50)) return reply(25001001, "page_size must be within [10, 50]");
    const body = parse(call.body) as { return_ids?: string[]; update_time_ge?: number; update_time_lt?: number };
    const all = returns
      .filter((r) => !body.return_ids || body.return_ids.includes(r.return_id))
      .filter((r) => body.update_time_ge === undefined || r.update_time >= body.update_time_ge)
      .filter((r) => body.update_time_lt === undefined || r.update_time < body.update_time_lt)
      .sort((a, b) => a.update_time - b.update_time);
    const p = page(all, q);
    return reply(0, "Success", {
      return_orders: p.slice.map((r) => ({ ...r, records: undefined })),
      total_count: p.total,
      next_page_token: p.next,
    });
  }
  if (key === "POST /return_refund/202602/cancellations/search") {
    const body = parse(call.body) as { order_ids?: string[]; cancel_types?: string[] };
    const all = cancellations
      .filter((c) => !body.order_ids || body.order_ids.includes(c.order_id))
      .filter((c) => !body.cancel_types || body.cancel_types.includes(c.cancel_type))
      .sort((a, b) => a.update_time - b.update_time);
    const p = page(all, q);
    return reply(0, "Success", { cancellations: p.slice, total_count: p.total, next_page_token: p.next });
  }
  if (key === "GET /return_refund/202601/decision_eligibility") {
    const id = q.return_or_cancel_id;
    const r = returns.find((x) => x.return_id === id);
    const c = cancellations.find((x) => x.cancel_id === id);
    if (!r && !c) return reply(25007006, "Order not found.");
    const ok = r ? eligible("return", r.return_type, r.return_status) : eligible("cancel", "", c!.cancel_status);
    return reply(0, "Success", {
      decisions: ALL_DECISIONS.map((decision) => ({
        decision,
        eligible: ok.includes(decision),
        ...(ok.includes(decision) ? {} : { ineligible_code: 25001001, ineligible_reason: "not allowed now" }),
        ...(decision.startsWith("REJECT_") && ok.includes(decision)
          ? { available_reject_reasons: TIKTOK_REJECT_REASONS }
          : {}),
      })),
    });
  }
  const records = /^\/return_refund\/202309\/returns\/(\d+)\/records$/.exec(call.path);
  if (call.method === "GET" && records) {
    const r = returns.find((x) => x.return_id === records[1]);
    if (!r) return reply(25007006, "Order not found.");
    return reply(0, "Success", { records: r.records ?? [] });
  }

  const decide = (requestId: string, apply: () => Reply): Reply => {
    const idem = q.idempotency_key;
    if (idem) {
      const seen = state.tiktokKeys.get(`${shop.cipher}:${idem}`);
      if (seen === requestId) return reply(0, "Success", {});
      state.tiktokKeys.set(`${shop.cipher}:${idem}`, requestId);
    }
    return apply();
  };
  const checkRejection = (body: { reject_reason?: string; images?: { image_id?: string }[] }): Reply | null => {
    if (!TIKTOK_REJECT_REASONS.some((x) => x.name === body.reject_reason)) {
      return reply(25001014, "Unknown return reason. Please ensure you are passing a valid return reason.");
    }
    if ((body.images ?? []).some((i) => !i.image_id || !uploadedImages.has(i.image_id))) {
      return reply(11050001, "invalid param");
    }
    return null;
  };

  const approve = /^\/return_refund\/202309\/returns\/(\d+)\/approve$/.exec(call.path);
  const reject = /^\/return_refund\/202606\/returns\/(\d+)\/reject$/.exec(call.path);
  if (call.method === "POST" && (approve || reject)) {
    const id = (approve ?? reject)![1]!;
    const r = returns.find((x) => x.return_id === id);
    if (!r) return reply(25007006, "Order not found.");
    const body = parse(call.body) as { decision?: string; reject_reason?: string; images?: { image_id?: string }[] };
    return decide(id, () => {
      const allowed = eligible("return", r.return_type, r.return_status);
      if (!body.decision || !allowed.includes(body.decision)) return reply(25020004, "decision not match reverse type");
      if (reject) {
        if (!REJECTED_STATUS[body.decision]) return reply(25020004, "decision not match reverse type");
        const bad = checkRejection(body);
        if (bad) return bad;
        state.rejections.push(body);
        r.return_status = REJECTED_STATUS[body.decision]!;
      } else {
        if (!APPROVED_STATUS[body.decision]) return reply(25020004, "decision not match reverse type");
        r.return_status = APPROVED_STATUS[body.decision]!;
      }
      r.seller_next_action_response = [];
      r.update_time = later(r.update_time);
      state.decisions.push(`tiktokshop:${id}:${body.decision}`);
      return reply(0, "Success", {});
    });
  }
  const cancel = /^\/return_refund\/202309\/cancellations\/(\d+)\/(approve|reject)$/.exec(call.path);
  if (call.method === "POST" && cancel) {
    const c = cancellations.find((x) => x.cancel_id === cancel[1]);
    if (!c) return reply(25007006, "Order not found.");
    return decide(c.cancel_id, () => {
      if (c.cancel_status !== "CANCELLATION_REQUEST_PENDING")
        return reply(25020003, "decision not match reverse status");
      if (cancel[2] === "reject") {
        const bad = checkRejection(parse(call.body) as { reject_reason?: string });
        if (bad) return bad;
      }
      const o = (shop.orders ?? []).find((x) => x.id === c.order_id);
      c.cancel_status = cancel[2] === "approve" ? "CANCELLATION_REQUEST_SUCCESS" : "CANCELLATION_REQUEST_CANCEL";
      c.seller_next_action_response = [];
      c.update_time = later(c.update_time);
      if (o) {
        o.is_buyer_request_cancel = false;
        if (cancel[2] === "approve") {
          o.status = "CANCELLED";
          o.cancellation_initiator = "BUYER";
        }
        o.update_time = later(o.update_time);
      }
      state.decisions.push(
        `tiktokshop:${c.cancel_id}:${cancel[2] === "approve" ? "APPROVE_REQUEST_CANCEL" : "REJECT_REQUEST_CANCEL"}`,
      );
      return reply(0, "Success", {});
    });
  }
  return null;
}
