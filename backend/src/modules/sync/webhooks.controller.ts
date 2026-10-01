import { Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { SUPPORTED_CHANNELS } from "../channel/connector-registry";
import { WebhookReceiver } from "./webhook-receiver.service";

export class WebhookChannelParamDto extends createZodDto(z.object({ channel: z.enum(SUPPORTED_CHANNELS) })) {}

/**
 * POST /webhooks/{channel} on the webhook process (backend doc 10.1). The body arrives as raw bytes
 * (see configureWebhookApp): signatures cover the exact bytes. The reply is 200 with an empty body,
 * which is what Shopee requires within 3 seconds and what TikTok Shop accepts.
 */
@ApiExcludeController()
@Controller("webhooks")
export class WebhooksController {
  constructor(@Inject(WebhookReceiver) private readonly receiver: WebhookReceiver) {}

  @Post(":channel")
  @HttpCode(200)
  async receive(@Param() params: WebhookChannelParamDto, @Req() req: Request): Promise<void> {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    await this.receiver.receive(params.channel, headers, raw);
  }
}
