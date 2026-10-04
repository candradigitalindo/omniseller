import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import { ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { DashboardService } from "./dashboard.service";
import {
  DashboardDto,
  DashboardQueryDto,
  dashboardView,
  SalesExportQueryDto,
  SalesReportDto,
  SalesReportQueryDto,
  salesReportView,
} from "./dto";
import { SalesReportService } from "./sales-report.service";

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

@ApiTags("reporting")
@Controller("v1/reports")
export class ReportsController {
  constructor(@Inject(SalesReportService) private readonly sales: SalesReportService) {}

  /** L30 Laporan Penjualan (FR-RPT-02): KPIs against the period before, chart, and breakdowns. */
  @Get("sales")
  @RequirePermission("report:read")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: SalesReportDto })
  async report(@Ctx() ctx: RequestContext, @Query() q: SalesReportQueryDto) {
    return salesReportView(await this.sales.report(ctx, q));
  }

  /** One section of the report as CSV (L30 "Unduh laporan"). */
  @Get("sales/export")
  @RequirePermission("report:read")
  @Isolation({ fixture: "order" })
  @ApiProduces("text/csv")
  @ApiOkResponse({ schema: { type: "string" }, description: "CSV, pemisah ;" })
  async export(@Ctx() ctx: RequestContext, @Query() q: SalesExportQueryDto, @Res() res: Response): Promise<void> {
    const { fileName, csv } = await this.sales.csv(ctx, q, q.section);
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${fileName}"`);
    res.setHeader("cache-control", "private, no-store");
    res.send(csv);
  }
}
