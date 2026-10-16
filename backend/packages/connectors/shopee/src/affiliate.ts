import {
  type MarketplaceConnector,
  type OpenCampaignProduct,
  type OpenCampaignProductPage,
  type OpenCampaignProductQuery,
  PermanentConnectorError,
} from "@omniseller/connector-core";
import type { ShopeeClient } from "./client.js";

/**
 * AMS open campaign products (API 2667, guide 702). Contract reviewed from the 2026-05-15 documentation
 * snapshot; current Console permissions and a real sandbox remain release requirements. This API is
 * GET despite its name and needs the Affiliate Marketing Solution Management app permission.
 */
const UNLIMITED_END = 32_503_651_199;

function badResponse(): never {
  throw new PermanentConnectorError({ code: "bad_response", message: "Invalid Shopee AMS product page" });
}

function invalidQuery(): never {
  throw new PermanentConnectorError({ code: "invalid_request", message: "Invalid Shopee AMS product query" });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return badResponse();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return badResponse();
}

function timestamp(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return badResponse();
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) return badResponse();
  return date;
}

/** The documented rate has at most two decimal places; split digits to avoid floating point rounding. */
function basisPoints(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return badResponse();
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return badResponse();
  const rate = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (rate > 10_000) return badResponse();
  return rate;
}

function product(value: unknown): OpenCampaignProduct {
  const item = record(value);
  if (typeof item.item_name !== "string" || typeof item.campaign_status !== "string") return badResponse();
  const statuses = new Map<string, OpenCampaignProduct["status"]>([
    ["Upcoming", "upcoming"],
    ["Ongoing", "ongoing"],
    ["Terminating", "terminating"],
  ]);
  const protection = item.commission_protection_list ?? [];
  if (!Array.isArray(protection)) return badResponse();
  return {
    externalItemId: identifier(item.item_id),
    title: item.item_name,
    externalCampaignId: identifier(item.campaign_id),
    status: statuses.get(item.campaign_status) ?? "unknown",
    externalStatus: item.campaign_status,
    commissionBasisPoints: basisPoints(item.commission_rate),
    startsAt: timestamp(item.period_start_time),
    endsAt: item.period_end_time === UNLIMITED_END ? null : timestamp(item.period_end_time),
    pendingTerminationAt:
      item.pending_terminated_time == null || item.pending_terminated_time === 0
        ? null
        : timestamp(item.pending_terminated_time),
    protections: protection.map((value) => {
      const row = record(value);
      return {
        commissionBasisPoints: basisPoints(row.commission_rate),
        endsAt: timestamp(row.protection_period_end_time),
      };
    }),
    maxCommissionBasisPointsToday:
      item.max_commission_rate_current_day == null ? null : basisPoints(item.max_commission_rate_current_day),
  };
}

function queryOf(input: OpenCampaignProductQuery): Record<string, string> {
  const size = input.pageSize ?? 100;
  if (!Number.isInteger(size) || size < 1 || size > 100) return invalidQuery();
  const query: Record<string, string> = { page_size: String(size) };
  if (input.cursor != null && input.cursor !== "") {
    if (typeof input.cursor !== "string") return invalidQuery();
    query.cursor = input.cursor;
  }
  if (input.sortBy !== undefined) {
    if (input.sortBy !== "commission_rate" && input.sortBy !== "-commission_rate") return invalidQuery();
    query.sort_by = input.sortBy;
  }
  if (input.search !== undefined) {
    if (typeof input.search.value !== "string") return invalidQuery();
    const value = input.search.value.trim();
    if (!value || (input.search.by !== "name" && input.search.by !== "id")) return invalidQuery();
    query.search_type = input.search.by === "id" ? "ITEM_ID" : "ITEM_NAME";
    if (input.search.by === "id") {
      const ids = value.split(",").map((id) => id.trim());
      if (ids.length > 50 || ids.some((id) => !/^[1-9]\d*$/.test(id))) return invalidQuery();
      query.search_content = ids.join(",");
    } else query.search_content = value;
  }
  return query;
}

export function shopeeAffiliate(client: ShopeeClient): NonNullable<MarketplaceConnector["affiliate"]> {
  return {
    async listOpenCampaignProducts(shop, input = {}): Promise<OpenCampaignProductPage> {
      const envelope = await client.shopCall<{ response?: unknown }>(
        shop,
        "GET",
        "/api/v2/ams/get_open_campaign_added_product",
        { query: queryOf(input) },
      );
      const page = record(envelope.response);
      if (
        !Array.isArray(page.item_list) ||
        !Number.isSafeInteger(page.total_count) ||
        Number(page.total_count) < 0 ||
        typeof page.has_more !== "boolean"
      )
        return badResponse();
      let nextCursor: string | null = null;
      if (page.has_more) {
        if (typeof page.cursor !== "string" || !page.cursor.trim() || page.cursor === input.cursor)
          return badResponse();
        nextCursor = page.cursor;
      }
      return { items: page.item_list.map(product), total: Number(page.total_count), nextCursor };
    },
  };
}
