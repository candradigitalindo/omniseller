import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import type { AuthedRequest } from "../../common/http/request";
import { CommerceRequestDto } from "../commerce/commerce.dto";
import {
  InboxConversationsDto,
  InboxCreateDto,
  InboxMessagesDto,
  InboxReadDto,
  InboxReceiptDto,
  InboxRequestParamDto,
  InboxSendDto,
} from "./commerce-inbox.dto";
import { CommerceInboxService } from "./commerce-inbox.service";

@ApiTags("commerce-inbox")
@Controller("v1/commerce-inbox")
export class CommerceInboxController {
  constructor(@Inject(CommerceInboxService) private readonly inbox: CommerceInboxService) {}
  @Post("conversations")
  @HttpCode(202)
  @ApiOperation({ summary: "Mulai percakapan dengan pembeli marketplace melalui worker" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @RequirePermission("chat:write")
  @Isolation({ fixture: "commerce_principal" })
  @ZodResponse({ status: 202, type: CommerceRequestDto })
  create(@Ctx() ctx: RequestContext, @Body() body: InboxCreateDto, @Req() req: AuthedRequest) {
    return this.inbox.create(ctx, body, req.get("Idempotency-Key"));
  }
  @Post("conversations/search")
  @HttpCode(202)
  @ApiOperation({ summary: "Ambil halaman percakapan marketplace melalui worker" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @RequirePermission("chat:read")
  @Isolation({ fixture: "commerce_principal" })
  @ZodResponse({ status: 202, type: CommerceRequestDto })
  conversations(@Ctx() ctx: RequestContext, @Body() body: InboxConversationsDto, @Req() req: AuthedRequest) {
    return this.inbox.conversations(ctx, body, req.get("Idempotency-Key"));
  }
  @Post("messages/search")
  @HttpCode(202)
  @ApiOperation({ summary: "Ambil halaman pesan marketplace melalui worker" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @RequirePermission("chat:read")
  @Isolation({ fixture: "commerce_principal" })
  @ZodResponse({ status: 202, type: CommerceRequestDto })
  messages(@Ctx() ctx: RequestContext, @Body() body: InboxMessagesDto, @Req() req: AuthedRequest) {
    return this.inbox.messages(ctx, body, req.get("Idempotency-Key"));
  }
  @Post("messages/send")
  @HttpCode(202)
  @ApiOperation({ summary: "Kirim balasan ke marketplace melalui worker" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @RequirePermission("chat:write")
  @Isolation({ fixture: "commerce_principal" })
  @ZodResponse({ status: 202, type: CommerceRequestDto })
  send(@Ctx() ctx: RequestContext, @Body() body: InboxSendDto, @Req() req: AuthedRequest) {
    return this.inbox.send(ctx, body, req.get("Idempotency-Key"));
  }
  @Post("messages/read")
  @HttpCode(202)
  @ApiOperation({ summary: "Tandai pesan marketplace sudah dibaca melalui worker" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @RequirePermission("chat:write")
  @Isolation({ fixture: "commerce_principal" })
  @ZodResponse({ status: 202, type: CommerceRequestDto })
  read(@Ctx() ctx: RequestContext, @Body() body: InboxReadDto, @Req() req: AuthedRequest) {
    return this.inbox.read(ctx, body, req.get("Idempotency-Key"));
  }
  @Get("requests/:id")
  @ApiOperation({ summary: "Status dan tampilan aman pesan marketplace" })
  @RequirePermission("chat:read")
  @Isolation({ fixture: "commerce_operation" })
  @ZodResponse({ type: InboxReceiptDto })
  receipt(@Ctx() ctx: RequestContext, @Param() param: InboxRequestParamDto) {
    return this.inbox.receipt(ctx, param.id);
  }
}
