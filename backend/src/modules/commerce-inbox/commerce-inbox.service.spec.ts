import { newId } from "@omniseller/shared";
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "../../common/context/request-context";
import type { CommerceService } from "../commerce/commerce.service";
import { CommerceInboxService } from "./commerce-inbox.service";
import { INBOX_OPERATIONS } from "./commerce-inbox-projection";

const ctx = systemContext(newId());
const principalId = newId();
const base = () => ({
  id: newId(),
  operationId: INBOX_OPERATIONS.send,
  storeId: principalId,
  requestedBy: ctx.actor.id,
  accountId: null,
  principalKind: "seller",
  status: "queued",
  result: null,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date(),
  finishedAt: null,
  expiresAt: new Date(Date.now() + 3600000),
});
function subject() {
  const commerce = { request: vi.fn().mockResolvedValue(base()), get: vi.fn() };
  return { commerce, service: new CommerceInboxService(commerce as unknown as CommerceService) };
}
describe("commerce inbox requests", () => {
  it("maps text to the documented serialized content and delegates to the guarded outbox service", async () => {
    const { commerce, service } = subject();
    await service.send(
      ctx,
      { principalId, conversationId: "7494560109732334261", type: "TEXT", text: "Halo" },
      "request-1234",
    );
    expect(commerce.request).toHaveBeenCalledWith(
      ctx,
      {
        operationId: INBOX_OPERATIONS.send,
        principalId,
        input: {
          path: { conversation_id: "7494560109732334261" },
          body: { type: "TEXT", content: '{"content":"Halo"}', sender_role: "CUSTOMER_SERVICE" },
        },
        confirmed: true,
      },
      "request-1234",
    );
  });
  it("rejects images from a different store, operation, failed upload or invalid dimensions", async () => {
    const { commerce, service } = subject();
    for (const change of [
      { requestedBy: newId() },
      { storeId: newId() },
      { operationId: INBOX_OPERATIONS.messages },
      { status: "uncertain" },
      { result: { data: { url: "javascript:alert(1)", width: 10, height: 10 } } },
      { result: { data: { url: "https://cdn.example.test/i", width: 0, height: 10 } } },
    ]) {
      commerce.get.mockResolvedValue({
        ...base(),
        status: "succeeded",
        operationId: INBOX_OPERATIONS.upload,
        result: { data: { url: "https://cdn.example.test/i", width: 10, height: 10 } },
        ...change,
      });
      await expect(
        service.send(
          ctx,
          { principalId, conversationId: "123", type: "IMAGE", uploadRequestId: newId() },
          "request-1234",
        ),
      ).rejects.toThrow();
    }
    expect(commerce.request).not.toHaveBeenCalled();
  });
  it("reuses only successful upload receipt metadata, without accepting an arbitrary client URL", async () => {
    const { commerce, service } = subject();
    commerce.get.mockResolvedValue({
      ...base(),
      operationId: INBOX_OPERATIONS.upload,
      status: "succeeded",
      result: { data: { url: "https://cdn.example.test/i", width: 10, height: 20 } },
    });
    await service.send(
      ctx,
      { principalId, conversationId: "123", type: "IMAGE", uploadRequestId: newId() },
      "request-1234",
    );
    expect(commerce.request.mock.calls[0]?.[1].input.body).toEqual({
      type: "IMAGE",
      content: '{"url":"https://cdn.example.test/i","width":10,"height":20}',
      sender_role: "CUSTOMER_SERVICE",
    });
  });
  it("binds large-video resources to the exact chat send target and rejects creator assets", async () => {
    const { commerce, service } = subject();
    const upload = {
      ...base(),
      operationId: INBOX_OPERATIONS.video,
      status: "succeeded",
      result: { data: { resource_id: "video-resource-1", target_operation_id: INBOX_OPERATIONS.send } },
    };
    commerce.get.mockResolvedValue(upload);
    await service.send(
      ctx,
      { principalId, conversationId: "123", type: "VIDEO", uploadRequestId: newId() },
      "request-1234",
    );
    expect(commerce.request.mock.calls[0]?.[1].input.body).toEqual({
      type: "VIDEO",
      content: '{"vid":"video-resource-1"}',
      sender_role: "CUSTOMER_SERVICE",
    });
    commerce.get.mockResolvedValue({
      ...upload,
      result: { data: { resource_id: "creator-video", target_operation_id: "creator-publish" } },
    });
    await expect(
      service.send(
        ctx,
        { principalId, conversationId: "123", type: "VIDEO", uploadRequestId: newId() },
        "request-1234",
      ),
    ).rejects.toThrow();
    expect(commerce.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ type: "PRODUCT_CARD", productId: "9007199254740993" }, { product_id: "9007199254740993" }],
    [{ type: "ORDER_CARD", orderId: "9007199254740993" }, { order_id: "9007199254740993" }],
    [{ type: "COUPON_CARD", couponId: "9007199254740993" }, { coupon_id: "9007199254740993" }],
    [
      { type: "LOGISTICS_CARD", orderId: "9007199254740993", packageId: "456" },
      { order_id: "9007199254740993", package_id: "456" },
    ],
    [
      { type: "RETURN_REFUND_CARD", orderId: "9007199254740993", skuId: "789" },
      { order_id: "9007199254740993", sku_id: "789" },
    ],
  ] as const)("serializes reviewed card content without rounding marketplace IDs: %j", async (fields, expected) => {
    const { commerce, service } = subject();
    await service.send(ctx, { principalId, conversationId: "123", ...fields }, "request-1234");
    expect(JSON.parse(commerce.request.mock.calls[0]?.[1].input.body.content)).toEqual(expected);
  });
});
