import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { DashboardService } from "./dashboard.service";
import { DashboardDto, DashboardQueryDto, dashboardView } from "./dto";

@ApiTags("reporting")
@Controller("v1/dashboard")
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  /** L01 Beranda (FR-RPT-01). Sections the caller may not see are null. */
  @Get()
  @RequirePermission("order:read")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: DashboardDto })
  async get(@Ctx() ctx: RequestContext, @Query() q: DashboardQueryDto) {
    return dashboardView(await this.dashboard.get(ctx, { range: q.range, storeId: q.storeId }));
  }
}
