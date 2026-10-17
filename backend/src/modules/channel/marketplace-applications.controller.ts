import { Body, Controller, Delete, Get, Inject, Param, Put, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import type { AuthedRequest } from "../../common/http/request";
import {
  MarketplaceApplicationDto,
  MarketplaceApplicationInputDto,
  MarketplaceApplicationListDto,
  MarketplaceApplicationParamDto,
} from "./marketplace-applications.dto";
import { MarketplaceApplicationsService } from "./marketplace-applications.service";

@ApiTags("channels")
@Controller("v1/marketplace-applications")
@RequirePermission("settings:store")
export class MarketplaceApplicationsController {
  constructor(@Inject(MarketplaceApplicationsService) private readonly applications: MarketplaceApplicationsService) {}
  @Get()
  @Isolation("self")
  @ZodResponse({ type: MarketplaceApplicationListDto })
  list(@Ctx() ctx: RequestContext) {
    return this.applications.list(ctx);
  }
  @Put(":channel")
  @Isolation("self")
  @ZodResponse({ type: MarketplaceApplicationDto })
  save(
    @Ctx() ctx: RequestContext,
    @Param() params: MarketplaceApplicationParamDto,
    @Body() input: MarketplaceApplicationInputDto,
  ) {
    return this.applications.save(ctx, params.channel, input);
  }
  @Delete(":channel")
  @Isolation("self")
  @ZodResponse({ type: MarketplaceApplicationDto })
  remove(@Ctx() ctx: RequestContext, @Param() params: MarketplaceApplicationParamDto, @Req() req: AuthedRequest) {
    return this.applications.remove(ctx, params.channel, parseIfMatch(req));
  }
}
