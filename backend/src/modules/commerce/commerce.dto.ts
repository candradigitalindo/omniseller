import type { CommerceField, CommerceOperation } from "@omniseller/connector-core";
import { COMMERCE_OPERATION_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { RequestContext } from "../../common/context/request-context";
import type { CommerceRow } from "./commerce.repository";
import { visibleCommerceData } from "./commerce-permissions";

const json = z.json();
const principalKind = z.enum(["seller", "creator", "affiliate_partner"]);
const field: z.ZodType<CommerceField> = z.lazy(() =>
  z.object({
    name: z.string(),
    label: z.string(),
    type: z.enum(["string", "integer", "number", "boolean", "enum", "object", "array", "file"]),
    required: z.boolean(),
    description: z.string().optional(),
    options: z.array(z.string()).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    maxLength: z.number().optional(),
    maxBytes: z.number().optional(),
    minBytes: z.number().optional(),
    maxBytesByMime: z.record(z.string(), z.number()).optional(),
    accept: z.array(z.string()).optional(),
    allowEmpty: z.boolean().optional(),
    timestampUnit: z.enum(["seconds", "milliseconds"]).optional(),
    format: z.enum(["money", "date", "datetime", "time"]).optional(),
    children: z.array(field).optional(),
    itemType: z.enum(["string", "integer", "number", "boolean", "object"]).optional(),
  }),
);
const operation: z.ZodType<CommerceOperation> = z.object({
  id: z.string(),
  channel: z.enum(["tiktokshop", "shopee"]),
  principalKind,
  title: z.string(),
  group: z.string(),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  path: z.string(),
  scopes: z.array(z.string()),
  scopeMode: z.enum(["all", "any"]).optional(),
  accountRequirements: z.array(z.enum(["cross_border", "local"])).optional(),
  write: z.boolean(),
  officialUrl: z.string(),
  fields: z.array(field),
  available: z.boolean(),
  requiredPermissions: z.array(z.string()).optional(),
  unavailableReason: z.string().nullable(),
  responseFields: z.array(z.string()).optional(),
  categoryAsset: z.boolean().optional(),
  transport: z.enum(["json", "multipart", "private_download", "large_upload"]).optional(),
  authMode: z.enum(["oauth_scope", "shopee_app_program"]).optional(),
  appPrograms: z.array(z.string()).optional(),
  eligibility: z.literal("unverified").optional(),
  eligibilityReason: z.string().optional(),
});
export class CommerceOperationsDto extends createZodDto(z.object({ items: z.array(operation) })) {}
export class CommercePrincipalsDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        id: ulidSchema,
        kind: principalKind,
        channel: z.enum(["tiktokshop", "shopee"]),
        name: z.string(),
        status: z.string(),
        scopes: z.array(z.string()),
        region: z.string(),
        readOnly: z.boolean(),
        sellerType: z.enum(["cross_border", "local", "unknown"]),
        categories: z.array(z.object({ id: z.number().int().positive(), name: z.string() })),
      }),
    ),
  }),
) {}
export class RequestCommerceDto extends createZodDto(
  z
    .object({
      operationId: z.string().min(1).max(200),
      principalId: ulidSchema,
      input: z
        .object({
          categoryAssetId: z.number().int().positive().optional(),
          path: z.record(z.string(), json).optional(),
          query: z.record(z.string(), json).optional(),
          body: z.record(z.string(), json).optional(),
        })
        .strict(),
      confirmed: z.boolean().default(false),
    })
    .strict(),
) {}
export class CommerceParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class CommerceListQueryDto extends createZodDto(
  z.object({
    principalId: ulidSchema.optional(),
    cursor: ulidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
) {}
const request = z.object({
  id: ulidSchema,
  operationId: z.string(),
  principalId: ulidSchema,
  principalKind,
  status: z.enum(COMMERCE_OPERATION_STATUSES),
  result: z
    .object({
      data: json,
      nextCursor: z.string().nullable(),
      acknowledgement: z.enum(["read", "accepted"]),
      artifact: z
        .object({ fileId: ulidSchema, mime: z.string(), sizeBytes: z.number().int(), expiresAt: z.iso.datetime() })
        .optional(),
    })
    .nullable(),
  nextCursor: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
});
export class CommerceRequestDto extends createZodDto(request) {}
export class CommerceRequestsDto extends createZodDto(
  z.object({ items: z.array(request), nextCursor: z.string().nullable() }),
) {}
export function commerceView(row: CommerceRow, ctx: RequestContext): z.input<typeof request> {
  return {
    id: row.id,
    operationId: row.operationId,
    principalId: row.storeId ?? row.accountId!,
    principalKind: row.principalKind,
    status: row.status,
    result: row.result ? { ...row.result, data: visibleCommerceData(ctx, row.result.data) } : null,
    nextCursor: row.result?.nextCursor ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
