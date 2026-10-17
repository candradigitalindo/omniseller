import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const applicationChannel = z.enum(["shopee", "tiktokshop"]);
export class MarketplaceApplicationParamDto extends createZodDto(z.object({ channel: applicationChannel })) {}
export class MarketplaceApplicationInputDto extends createZodDto(
  z
    .object({
      environment: z.enum(["production", "sandbox"]).default("production"),
      partnerId: z
        .string()
        .regex(/^[1-9][0-9]{0,14}$/, "Partner ID harus berupa angka.")
        .optional(),
      appKey: z.string().trim().min(1).max(200).optional(),
      serviceId: z.string().trim().min(1).max(200).optional(),
      secret: z.string().min(8).max(4096),
      expectedVersion: z.number().int().positive().optional(),
    })
    .strict(),
) {}

const view = z.object({
  channel: applicationChannel,
  source: z.enum(["tenant", "platform", "unconfigured"]),
  applicationId: ulidSchema.nullable(),
  configured: z.boolean(),
  environment: z.enum(["production", "sandbox"]),
  partnerId: z.string().nullable(),
  appKey: z.string().nullable(),
  serviceId: z.string().nullable(),
  secretConfigured: z.boolean(),
  rowVersion: z.number().int().nullable(),
  redirectUrl: z.string(),
  webhookUrl: z.string().nullable(),
  settingsEnabled: z.boolean(),
});
export class MarketplaceApplicationDto extends createZodDto(view) {}
export class MarketplaceApplicationListDto extends createZodDto(z.object({ items: z.array(view) })) {}
