import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import type { AuthedRequest } from "../../common/http/request";
import {
  CommerceListQueryDto,
  CommerceOperationsDto,
  CommerceParamDto,
  CommercePrincipalsDto,
  CommerceRequestDto,
  CommerceRequestsDto,
  commerceView,
  RequestCommerceDto,
} from "./commerce.dto";
import { CommerceService } from "./commerce.service";
@ApiTags("commerce")
@Controller("v1/commerce")
export class CommerceController {
  constructor(@Inject(CommerceService) private readonly commerce: CommerceService) {}
  @Get("operations")
  @ApiOperation({ summary: "Operasi commerce dan kontrak field yang telah ditinjau" })
  @RequirePermission("commerce:read")
  @Isolation("global")
  @ZodResponse({ type: CommerceOperationsDto })
  operations() {
    return { items: this.commerce.operations() };
  }
  @Get("principals")
  @ApiOperation({ summary: "Akun commerce yang dapat diakses pengguna" })
  @RequirePermission("commerce:read")
  @Isolation({ fixture: "commerce_principal" })
  @ZodResponse({ type: CommercePrincipalsDto })
  async principals(@Ctx() ctx: RequestContext) {
    return { items: await this.commerce.principals(ctx) };
  }
  @Post("requests")
  @HttpCode(202)
  @ApiOperation({ summary: "Jalankan satu operasi commerce melalui worker" })
  @ApiHeader({ name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 100 } })
  @RequirePermission("commerce:read")
  @Isolation({ fixture: "commerce_operation" })
  @ZodResponse({ status: 202, type: CommerceRequestDto })
  async request(@Ctx() ctx: RequestContext, @Body() body: RequestCommerceDto, @Req() req: AuthedRequest) {
    return commerceView(await this.commerce.request(ctx, body, req.get("Idempotency-Key")), ctx);
  }
  @Get("requests")
  @ApiOperation({ summary: "Riwayat permintaan commerce dalam masa simpan" })
  @RequirePermission("commerce:read")
  @Isolation({ fixture: "commerce_operation" })
  @ZodResponse({ type: CommerceRequestsDto })
  async list(@Ctx() ctx: RequestContext, @Query() query: CommerceListQueryDto) {
    const result = await this.commerce.list(ctx, query);
    return { ...result, items: result.items.map((row) => commerceView(row, ctx)) };
  }
  @Get("requests/:id")
  @ApiOperation({ summary: "Status dan hasil operasi commerce" })
  @RequirePermission("commerce:read")
  @Isolation({ fixture: "commerce_operation" })
  @ZodResponse({ type: CommerceRequestDto })
  async get(@Ctx() ctx: RequestContext, @Param() param: CommerceParamDto) {
    return commerceView(await this.commerce.get(ctx, param.id), ctx);
  }
}
