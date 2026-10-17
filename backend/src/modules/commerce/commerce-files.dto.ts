import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
export class UploadCommerceFileDto extends createZodDto(
  z.object({ operationId: z.string().min(1).max(200), principalId: ulidSchema }),
) {}
export class CommerceFileDto extends createZodDto(
  z.object({
    fileId: ulidSchema,
    filename: z.string(),
    mime: z.string(),
    sizeBytes: z.number().int(),
    expiresAt: z.iso.datetime(),
  }),
) {}
