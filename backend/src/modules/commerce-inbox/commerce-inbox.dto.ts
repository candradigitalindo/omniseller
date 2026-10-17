import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const conversationId = z.string().regex(/^\d{1,30}$/);
const principal = { principalId: ulidSchema };
const page = { cursor: z.string().max(2048).optional() };
export class InboxConversationsDto extends createZodDto(z.object({ ...principal, ...page }).strict()) {}
export class InboxMessagesDto extends createZodDto(z.object({ ...principal, ...page, conversationId }).strict()) {}
export class InboxCreateDto extends createZodDto(z.object({ ...principal, buyerUserId: conversationId }).strict()) {}
export class InboxReadDto extends createZodDto(z.object({ ...principal, conversationId }).strict()) {}
const target = { ...principal, conversationId };
const sendFields = {
  TEXT: ["text"],
  IMAGE: ["uploadRequestId"],
  VIDEO: ["uploadRequestId"],
  ORDER_CARD: ["orderId"],
  PRODUCT_CARD: ["productId"],
  COUPON_CARD: ["couponId"],
  LOGISTICS_CARD: ["orderId", "packageId"],
  RETURN_REFUND_CARD: ["orderId", "skuId"],
} as const;
export class InboxSendDto extends createZodDto(
  z
    .object({
      ...target,
      type: z.enum([
        "TEXT",
        "IMAGE",
        "VIDEO",
        "ORDER_CARD",
        "PRODUCT_CARD",
        "COUPON_CARD",
        "LOGISTICS_CARD",
        "RETURN_REFUND_CARD",
      ]),
      text: z.string().trim().min(1).max(2000).optional(),
      uploadRequestId: ulidSchema.optional(),
      orderId: conversationId.optional(),
      productId: conversationId.optional(),
      couponId: conversationId.optional(),
      packageId: conversationId.optional(),
      skuId: conversationId.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const allowed: readonly string[] = sendFields[value.type];
      for (const field of allowed) {
        if (field !== "packageId" && !value[field as keyof typeof value])
          ctx.addIssue({ code: "custom", path: [field], message: "Isi balasan sesuai jenis pesan." });
      }
      for (const field of [
        "text",
        "uploadRequestId",
        "orderId",
        "productId",
        "couponId",
        "packageId",
        "skuId",
      ] as const) {
        if (!allowed.includes(field) && value[field] !== undefined)
          ctx.addIssue({ code: "custom", path: [field], message: "Isian tidak sesuai jenis pesan." });
      }
    }),
) {}
export class InboxRequestParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
const message = z.object({
  id: z.string(),
  type: z.string(),
  text: z.string(),
  sender: z.string(),
  incoming: z.boolean(),
  createdAt: z.iso.datetime().nullable(),
  mediaUrl: z.string().nullable(),
});
export class InboxReceiptDto extends createZodDto(
  z.object({
    id: ulidSchema,
    principalId: ulidSchema,
    status: z.enum(["queued", "running", "succeeded", "failed", "uncertain"]),
    kind: z.enum(["conversations", "messages", "send", "read", "upload", "video", "create"]),
    nextCursor: z.string().nullable(),
    errorMessage: z.string().nullable(),
    conversations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        preview: z.string(),
        unread: z.number().int(),
        canReply: z.boolean(),
        updatedAt: z.iso.datetime().nullable(),
      }),
    ),
    messages: z.array(message),
    messageId: z.string().nullable(),
    conversationId: z.string().nullable(),
  }),
) {}
