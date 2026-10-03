import { Controller, Get, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import { ApiFoundResponse, ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { DataExportDto, DataExportListDto, ExportIdParamDto, exportView } from "./dto";
import { ExportsService } from "./exports.service";

@ApiTags("exports")
@Controller("v1/exports")
export class ExportsController {
  constructor(@Inject(ExportsService) private readonly exports: ExportsService) {}

  /**
   * FR-MIG-09: every CSV of the business in one ZIP, made by the worker; the caller polls the export
   * (202). While one is being made, the answer is that one.
   */
  @Post()
  @HttpCode(202)
  @RequirePermission("data:export")
  @Isolation("self")
  @ZodResponse({ type: DataExportDto, status: 202 })
  async request(@Ctx() ctx: RequestContext) {
    return exportView(await this.exports.request(ctx));
  }

  @Get()
  @RequirePermission("data:export")
  @Isolation({ fixture: "data_export" })
  @ZodResponse({ type: DataExportListDto })
  async list(@Ctx() ctx: RequestContext) {
    return { items: (await this.exports.list(ctx)).map((e) => exportView(e)) };
  }

  @Get(":id")
  @RequirePermission("data:export")
  @Isolation({ fixture: "data_export" })
  @ZodResponse({ type: DataExportDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: ExportIdParamDto) {
    return exportView(await this.exports.get(ctx, p.id));
  }

  /** With R2 a redirect to a signed link valid for 10 minutes; with local storage the ZIP itself. */
  @Get(":id/download")
  @RequirePermission("data:export")
  @Isolation({ fixture: "data_export" })
  @ApiProduces("application/zip")
  @ApiOkResponse({ description: "The ZIP (local storage)." })
  @ApiFoundResponse({ description: "Redirect to a signed link valid for 10 minutes (R2)." })
  async download(@Ctx() ctx: RequestContext, @Param() p: ExportIdParamDto, @Res() res: Response): Promise<void> {
    const target = await this.exports.download(ctx, p.id);
    res.setHeader("cache-control", "private, no-store");
    if ("url" in target) {
      res.redirect(302, target.url);
      return;
    }
    res.setHeader("content-type", target.mime);
    res.setHeader("content-disposition", `${target.disposition}; filename="${target.filename}"`);
    res.send(Buffer.from(target.bytes));
  }
}
