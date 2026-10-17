import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import type { AuthedRequest } from "../../common/http/request";
import {
  AffiliateProductsDto,
  AffiliateProductsResultDto,
  AffiliateResultQueryDto,
  AffiliateStoreParamDto,
  affiliateQueryView,
  RequestAffiliateProductsDto,
} from "./affiliate.dto";
import { AffiliateService } from "./affiliate.service";
@ApiTags("affiliate")
@Controller("v1/stores/:id/affiliate/products")
export class AffiliateProductsController {
  constructor(@Inject(AffiliateService) private readonly affiliate: AffiliateService) {}
  @Get()
  @ApiOperation({ summary: "Hasil pembacaan produk open campaign AMS toko" })
  @RequirePermission("affiliate:read")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: AffiliateProductsResultDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: AffiliateStoreParamDto, @Query() q: AffiliateResultQueryDto) {
    const row = await this.affiliate.get(ctx, p.id, q.requestId);
    return { request: row ? affiliateQueryView(row) : null };
  }
  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: "Antrekan pembacaan satu halaman produk open campaign AMS" })
  @ApiHeader({ name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 100 } })
  @RequirePermission("affiliate:read")
  @Isolation({ fixture: "store" })
  @ZodResponse({ status: 202, type: AffiliateProductsDto })
  async request(
    @Ctx() ctx: RequestContext,
    @Param() p: AffiliateStoreParamDto,
    @Body() body: RequestAffiliateProductsDto,
    @Req() req: AuthedRequest,
  ) {
    return affiliateQueryView(await this.affiliate.request(ctx, p.id, body, req.get("Idempotency-Key")));
  }
}
