import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import { ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { sendAttachment } from "../../common/http/send-download";
import { XLSX_MIME } from "../../common/xlsx";
import { DashboardService } from "./dashboard.service";
import {
  DashboardDto,
  DashboardQueryDto,
  dashboardView,
  SalesExportQueryDto,
  SalesReportDto,
  SalesReportQueryDto,
  StaffExportQueryDto,
  StaffReportDto,
  StaffReportQueryDto,
  salesReportView,
  staffReportView,
} from "./dto";
import { SalesReportService } from "./sales-report.service";
import { StaffReportService } from "./staff-report.service";

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
  constructor(
    @Inject(SalesReportService) private readonly sales: SalesReportService,
    @Inject(StaffReportService) private readonly staff: StaffReportService,
  ) {}

  /** L30 Laporan Penjualan (FR-RPT-02): KPIs against the period before, chart, and breakdowns. */
  @Get("sales")
  @RequirePermission("report:read")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: SalesReportDto })
  async report(@Ctx() ctx: RequestContext, @Query() q: SalesReportQueryDto) {
    return salesReportView(await this.sales.report(ctx, q));
  }

  /** One section of the report as CSV, or the whole report as an Excel workbook (L30 "Unduh laporan"). */
  @Get("sales/export")
  @RequirePermission("report:read")
  @Isolation({ fixture: "order" })
  @ApiProduces("text/csv", XLSX_MIME)
  @ApiOkResponse({ schema: { type: "string" }, description: "CSV (pemisah ;) atau berkas Excel (.xlsx)" })
  async export(@Ctx() ctx: RequestContext, @Query() q: SalesExportQueryDto, @Res() res: Response): Promise<void> {
    if (q.format === "xlsx") {
      const { fileName, bytes } = await this.sales.workbook(ctx, q);
      sendAttachment(res, fileName, XLSX_MIME, bytes);
      return;
    }
    const { fileName, csv } = await this.sales.csv(ctx, q, q.section);
    sendAttachment(res, fileName, "text/csv; charset=utf-8", csv);
  }

  /**
   * L33 Kinerja Tim (FR-RPT-10), from plan Growth on: what each member did to orders in OmniSeller, per
   * member and per day. 422 `billing.feature_unavailable` on plans without it.
   */
  @Get("staff")
  @RequirePermission("settings:user")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: StaffReportDto })
  async staffReport(@Ctx() ctx: RequestContext, @Query() q: StaffReportQueryDto) {
    return staffReportView(await this.staff.report(ctx, q));
  }

  /** The team report as CSV (per member, or per member per day) or as an Excel workbook of both (L33 "Unduh"). */
  @Get("staff/export")
  @RequirePermission("settings:user")
  @Isolation({ fixture: "order" })
  @ApiProduces("text/csv", XLSX_MIME)
  @ApiOkResponse({ schema: { type: "string" }, description: "CSV (pemisah ;) atau berkas Excel (.xlsx)" })
  async staffExport(@Ctx() ctx: RequestContext, @Query() q: StaffExportQueryDto, @Res() res: Response): Promise<void> {
    if (q.format === "xlsx") {
      const { fileName, bytes } = await this.staff.workbook(ctx, q);
      sendAttachment(res, fileName, XLSX_MIME, bytes);
      return;
    }
    const { fileName, csv } = await this.staff.csv(ctx, q, q.section);
    sendAttachment(res, fileName, "text/csv; charset=utf-8", csv);
  }
}
