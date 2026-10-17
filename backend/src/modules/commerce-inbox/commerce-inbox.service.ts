import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { NotFoundError, ValidationError } from "../../common/errors/domain-errors";
import { commerceView } from "../commerce/commerce.dto";
import { CommerceService } from "../commerce/commerce.service";
import {
  InboxConversationsDto,
  InboxCreateDto,
  InboxMessagesDto,
  InboxReadDto,
  InboxSendDto,
} from "./commerce-inbox.dto";
import { INBOX_OPERATIONS, inboxConversations, inboxMessages, mediaUrl, record } from "./commerce-inbox-projection";

@Injectable()
export class CommerceInboxService {
  constructor(@Inject(CommerceService) private readonly commerce: CommerceService) {}
  async create(ctx: RequestContext, body: InboxCreateDto, key?: string) {
    return this.request(
      ctx,
      INBOX_OPERATIONS.create,
      body.principalId,
      { body: { buyer_user_id: body.buyerUserId } },
      key,
    );
  }
  async conversations(ctx: RequestContext, body: InboxConversationsDto, key?: string) {
    return this.request(
      ctx,
      INBOX_OPERATIONS.conversations,
      body.principalId,
      {
        query: { page_size: 10, locale: "id-ID", ...(body.cursor ? { page_token: body.cursor } : {}) },
      },
      key,
    );
  }
  async messages(ctx: RequestContext, body: InboxMessagesDto, key?: string) {
    return this.request(
      ctx,
      INBOX_OPERATIONS.messages,
      body.principalId,
      {
        path: { conversation_id: body.conversationId },
        query: {
          page_size: 10,
          locale: "id-ID",
          sort_order: "DESC",
          sort_field: "create_time",
          need_plaintext: true,
          ...(body.cursor ? { page_token: body.cursor } : {}),
        },
      },
      key,
    );
  }
  async read(ctx: RequestContext, body: InboxReadDto, key?: string) {
    return this.request(
      ctx,
      INBOX_OPERATIONS.read,
      body.principalId,
      { path: { conversation_id: body.conversationId } },
      key,
    );
  }
  async send(ctx: RequestContext, body: InboxSendDto, key?: string) {
    let content: Record<string, unknown>;
    if (body.type === "TEXT") content = { content: body.text };
    else if (body.type === "IMAGE" || body.type === "VIDEO") {
      // Only this user's successful upload receipt for this store can supply marketplace media metadata.
      const upload = await this.commerce.get(ctx, body.uploadRequestId!);
      const media = record(upload.result?.data);
      const video = body.type === "VIDEO";
      if (
        upload.requestedBy !== ctx.actor.id ||
        upload.storeId !== body.principalId ||
        upload.status !== "succeeded" ||
        upload.operationId !== (video ? INBOX_OPERATIONS.video : INBOX_OPERATIONS.upload)
      )
        throw new ValidationError([
          { path: "uploadRequestId", message: "Unggah lampiran untuk toko ini sampai selesai sebelum mengirim." },
        ]);
      if (video) {
        if (
          media.target_operation_id !== INBOX_OPERATIONS.send ||
          typeof media.resource_id !== "string" ||
          !media.resource_id ||
          media.resource_id.length > 500
        )
          throw new ValidationError([
            { path: "uploadRequestId", message: "Aset video belum tersedia untuk pengiriman pesan." },
          ]);
        content = { vid: media.resource_id };
      } else {
        if (
          !mediaUrl(media.url) ||
          !Number.isSafeInteger(media.width) ||
          !Number.isSafeInteger(media.height) ||
          Number(media.width) <= 0 ||
          Number(media.height) <= 0
        )
          throw new ValidationError([
            { path: "uploadRequestId", message: "Aset gambar belum tersedia untuk pengiriman pesan." },
          ]);
        content = { url: media.url, width: media.width, height: media.height };
      }
    } else if (body.type === "PRODUCT_CARD") content = { product_id: body.productId };
    else if (body.type === "ORDER_CARD") content = { order_id: body.orderId };
    else if (body.type === "LOGISTICS_CARD")
      content = { order_id: body.orderId, ...(body.packageId ? { package_id: body.packageId } : {}) };
    else if (body.type === "RETURN_REFUND_CARD") content = { order_id: body.orderId, sku_id: body.skuId };
    else content = { coupon_id: body.couponId };
    return this.request(
      ctx,
      INBOX_OPERATIONS.send,
      body.principalId,
      {
        path: { conversation_id: body.conversationId },
        body: { type: body.type, content: JSON.stringify(content), sender_role: "CUSTOMER_SERVICE" },
      },
      key,
    );
  }
  async receipt(ctx: RequestContext, id: string) {
    const row = await this.commerce.get(ctx, id);
    const kind = Object.entries(INBOX_OPERATIONS).find(([, operation]) => operation === row.operationId)?.[0];
    if (!kind) throw new NotFoundError("commerce_inbox.not_found", "Permintaan pesan tidak ditemukan.");
    const data = row.status === "succeeded" ? record(row.result?.data) : {};
    return {
      id: row.id,
      principalId: row.storeId!,
      status: row.status,
      kind: kind as keyof typeof INBOX_OPERATIONS,
      nextCursor: row.result?.nextCursor ?? null,
      errorMessage: row.errorMessage,
      conversations: kind === "conversations" ? inboxConversations(data) : [],
      messages: kind === "messages" ? inboxMessages(data) : [],
      messageId: typeof data.message_id === "string" ? data.message_id : null,
      conversationId: typeof data.conversation_id === "string" ? data.conversation_id : null,
    };
  }
  private async request(
    ctx: RequestContext,
    operationId: string,
    principalId: string,
    input: Parameters<CommerceService["request"]>[1]["input"],
    key?: string,
  ) {
    return commerceView(
      await this.commerce.request(ctx, { operationId, principalId, input, confirmed: true }, key),
      ctx,
    );
  }
}
