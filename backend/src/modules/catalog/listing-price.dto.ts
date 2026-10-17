import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { PriceChangeRow } from "./listing-price.repository";

const price = z.number().int().min(1).max(1_000_000_000_000);
export class RequestListingPriceDto extends createZodDto(z.object({ price, expectedPrice: price })) {}
export class CancelListingPriceDto extends createZodDto(z.object({ changeId: ulidSchema })) {}
const change = z.object({
  id: ulidSchema,
  listingId: ulidSchema,
  expectedPrice: price,
  requestedPrice: price,
  observedPrice: z.number().int().nullable(),
  status: z.enum(["queued", "processing", "succeeded", "failed", "cancelled"]),
  canCancel: z.boolean(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export class ListingPriceChangeDto extends createZodDto(change) {}
export class ListingPriceHistoryDto extends createZodDto(z.object({ items: z.array(change) })) {}
export const priceChangeView = (row: PriceChangeRow): z.infer<typeof change> => ({
  id: row.id,
  listingId: row.listingId,
  expectedPrice: row.expectedPrice,
  requestedPrice: row.requestedPrice,
  observedPrice: row.observedPrice,
  status: row.status,
  canCancel: row.status === "queued" && row.sentAt === null,
  errorCode: row.errorCode,
  errorMessage: row.errorMessage,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
