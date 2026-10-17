import { AFFILIATE_ACCOUNT_STATUSES, AFFILIATE_AUTHORIZATION_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import type { AffiliateAccountRow, AffiliateAuthorizationMeta } from "./accounts.repository";

const kind = z.enum(["creator", "affiliate_partner"]);
const account = z.object({
  id: ulidSchema,
  channel: z.enum(["tiktokshop", "shopee"]),
  program: z.enum(["standard", "video", "live"]),
  kind,
  name: z.string(),
  externalPrincipalId: z.string(),
  region: z.string(),
  regionVerified: z.boolean(),
  status: z.enum(AFFILIATE_ACCOUNT_STATUSES),
  scopes: z.array(z.string()),
  profile: z.record(z.string(), z.unknown()),
  connectedAt: z.iso.datetime(),
  disconnectedAt: z.iso.datetime().nullable(),
  accessExpiresAt: z.iso.datetime().nullable(),
  authorizationExpiresAt: z.iso.datetime().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  rowVersion: z.number().int(),
});
const authorization = z.object({
  id: ulidSchema,
  channel: z.enum(["tiktokshop", "shopee"]),
  program: z.enum(["standard", "video", "live"]),
  kind,
  accountId: ulidSchema.nullable(),
  status: z.enum(AFFILIATE_AUTHORIZATION_STATUSES),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export class AffiliateAccountDto extends createZodDto(account) {}
export class AffiliateAccountPageDto extends createZodDto(pageSchema(account)) {}
export class AffiliateAccountIdDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class AffiliateAccountQueryDto extends createZodDto(
  paginationQuery.extend({ q: z.string().trim().max(200).optional() }),
) {}
export class RenameAffiliateAccountDto extends createZodDto(z.object({ name: z.string().trim().min(1).max(100) })) {}
export class StartAffiliateAuthorizationDto extends createZodDto(
  z.object({
    kind,
    channel: z.enum(["tiktokshop", "shopee"]).optional(),
    program: z.enum(["standard", "video", "live"]).optional(),
    accountId: ulidSchema.optional(),
  }),
) {}
export class AffiliateAuthorizationDto extends createZodDto(authorization) {}
export class StartedAffiliateAuthorizationDto extends createZodDto(authorization.extend({ authorizeUrl: z.url() })) {}
export class AffiliateAccountCallbackDto extends createZodDto(
  z.object({
    state: z.string().min(32).max(200),
    channel: z.enum(["tiktokshop", "shopee"]).optional(),
    code: z.string().min(1).max(2000).optional(),
    error: z.string().max(200).optional(),
  }),
) {}
export const accountView = (r: AffiliateAccountRow): z.infer<typeof account> => ({
  id: r.id,
  channel: r.channel,
  program: r.program,
  kind: r.kind,
  name: r.name,
  externalPrincipalId: r.externalPrincipalId,
  region: r.region,
  regionVerified: r.regionVerified,
  status: r.status,
  scopes: r.scopes,
  profile: r.profile,
  connectedAt: r.connectedAt.toISOString(),
  disconnectedAt: r.disconnectedAt?.toISOString() ?? null,
  accessExpiresAt: r.accessExpiresAt?.toISOString() ?? null,
  authorizationExpiresAt: r.authorizationExpiresAt?.toISOString() ?? null,
  errorCode: r.errorCode,
  errorMessage: r.errorMessage,
  rowVersion: r.rowVersion,
});
export const authorizationView = (r: AffiliateAuthorizationMeta): z.infer<typeof authorization> => ({
  id: r.id,
  channel: r.channel,
  program: r.program,
  kind: r.kind,
  accountId: r.accountId,
  status: r.status,
  expiresAt: r.expiresAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
  completedAt: r.completedAt?.toISOString() ?? null,
  errorCode: r.errorCode,
  errorMessage: r.errorMessage,
});
