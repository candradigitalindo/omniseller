import { AFFILIATE_QUERY_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { AffiliateQueryRow } from "./affiliate.repository";

const query = z
  .object({
    pageSize: z.number().int().min(1).max(100).default(20),
    cursor: z.string().trim().min(1).max(2000).nullable().optional(),
    sortBy: z.enum(["commission_rate", "-commission_rate"]).optional(),
    search: z.object({ by: z.enum(["name", "id"]), value: z.string().trim().min(1).max(2000) }).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.search?.by === "id") {
      const ids = value.search.value.split(",").map((s) => s.trim());
      if (ids.length > 50 || ids.some((id) => !/^[1-9]\d*$/.test(id)))
        ctx.addIssue({
          code: "custom",
          path: ["search", "value"],
          message: "Isi maksimal 50 ID produk, dipisahkan koma.",
        });
    } else if (value.search && value.search.value.length > 200)
      ctx.addIssue({ code: "custom", path: ["search", "value"], message: "Pencarian nama maksimal 200 karakter." });
  });
export class RequestAffiliateProductsDto extends createZodDto(query) {}
export class AffiliateStoreParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class AffiliateResultQueryDto extends createZodDto(z.object({ requestId: ulidSchema.optional() })) {}
const bps = z.number().int().min(0).max(10_000);
const product = z.object({
  externalItemId: z.string(),
  title: z.string(),
  externalCampaignId: z.string(),
  status: z.enum(["upcoming", "ongoing", "terminating", "unknown"]),
  externalStatus: z.string(),
  commissionBasisPoints: bps,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime().nullable(),
  pendingTerminationAt: z.iso.datetime().nullable(),
  protections: z.array(z.object({ commissionBasisPoints: bps, endsAt: z.iso.datetime() })),
  maxCommissionBasisPointsToday: bps.nullable(),
});
const result = z.object({
  id: ulidSchema,
  storeId: ulidSchema,
  query,
  status: z.enum(AFFILIATE_QUERY_STATUSES),
  items: z.array(product),
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
});
export class AffiliateProductsDto extends createZodDto(result) {}
export class AffiliateProductsResultDto extends createZodDto(z.object({ request: result.nullable() })) {}
export const affiliateQueryView = (r: AffiliateQueryRow): z.input<typeof result> => ({
  id: r.id,
  storeId: r.storeId,
  query: r.query,
  status: r.status,
  items: r.items,
  total: r.total,
  nextCursor: r.nextCursor,
  errorCode: r.errorCode,
  errorMessage: r.errorMessage,
  createdAt: r.createdAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
  expiresAt: r.expiresAt.toISOString(),
});
