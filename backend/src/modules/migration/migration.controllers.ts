import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from "@nestjs/common";
import { ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { CutoverService } from "./cutover.service";
import {
  ComparisonQueryDto,
  CutoverCheckQueryDto,
  CutoverDto,
  CutoverIdParamDto,
  CutoverListDto,
  CutoverRequestDto,
  comparisonView,
  cutoverView,
  decodeErrorCursor,
  ErrorsQueryDto,
  encodeErrorCursor,
  ImportFieldsDto,
  ImportIdParamDto,
  ImportJobDto,
  ImportJobListDto,
  importFieldsView,
  importJobView,
  PresetDto,
  PresetIdParamDto,
  PresetListDto,
  presetView,
  RowErrorListDto,
  rowErrorView,
  SavePresetDto,
  SetMappingDto,
  StockComparisonDto,
  StoreIdParamDto,
  StoreStateListDto,
  storeStateView,
  UploadImportDto,
} from "./dto";
import { ImportsService } from "./imports.service";
import { ParallelModeService } from "./parallel-mode.service";

/** L46 Migrasi Data, steps 1 to 3 (FR-MIG-01): upload, map columns, validate, import. */
@ApiTags("migration")
@Controller("v1/migration")
export class MigrationImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  /** The OmniSeller fields a file can fill and the apps there are presets for. */
  @Get("fields")
  @RequirePermission("settings:store")
  @Isolation("global")
  @ZodResponse({ type: ImportFieldsDto })
  fields() {
    return importFieldsView();
  }

  /** Reads the file, guesses the header row and the mapping, and keeps the file privately for 30 days. */
  @Post("imports")
  @HttpCode(201)
  @RequirePermission("settings:store")
  @Isolation("self")
  @ZodResponse({ type: ImportJobDto, status: 201 })
  async upload(@Ctx() ctx: RequestContext, @Body() body: UploadImportDto) {
    return importJobView(await this.imports.upload(ctx, body));
  }

  @Get("imports")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "migration_job" })
  @ZodResponse({ type: ImportJobListDto })
  async list(@Ctx() ctx: RequestContext) {
    return { items: (await this.imports.list(ctx)).map(importJobView) };
  }

  @Get("imports/:id")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "migration_job" })
  @ZodResponse({ type: ImportJobDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: ImportIdParamDto) {
    return importJobView(await this.imports.get(ctx, p.id));
  }

  @Put("imports/:id/mapping")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "migration_job" })
  @ZodResponse({ type: ImportJobDto })
  async setMapping(@Ctx() ctx: RequestContext, @Param() p: ImportIdParamDto, @Body() body: SetMappingDto) {
    return importJobView(await this.imports.setMapping(ctx, p.id, body));
  }

  /** Checks every row in the worker (202); the job becomes `validated` or `invalid`. */
  @Post("imports/:id/validate")
  @HttpCode(202)
  @RequirePermission("settings:store")
  @Isolation({ fixture: "migration_job" })
  @ZodResponse({ type: ImportJobDto, status: 202 })
  async validate(@Ctx() ctx: RequestContext, @Param() p: ImportIdParamDto) {
    return importJobView(await this.imports.requestValidation(ctx, p.id));
  }

  /** Imports a validated file in the worker (202), all rows or none. */
  @Post("imports/:id/import")
  @HttpCode(202)
  @RequirePermission("settings:store")
  @Isolation({ fixture: "migration_job" })
  @ZodResponse({ type: ImportJobDto, status: 202 })
  async import(@Ctx() ctx: RequestContext, @Param() p: ImportIdParamDto) {
    return importJobView(await this.imports.requestImport(ctx, p.id));
  }

  @Get("imports/:id/errors")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "migration_job" })
  @ZodResponse({ type: RowErrorListDto })
  async errors(@Ctx() ctx: RequestContext, @Param() p: ImportIdParamDto, @Query() q: ErrorsQueryDto) {
    const rows = await this.imports.errors(ctx, p.id, decodeErrorCursor(q.cursor), q.limit + 1);
    const page = rows.slice(0, q.limit);
    return {
      items: page.map(rowErrorView),
      nextCursor: rows.length > q.limit ? encodeErrorCursor(page[page.length - 1]!) : null,
    };
  }

  /** The problems with each row as it was in the file, as CSV (UI L46 "unduh daftar gagal"). */
  @Get("imports/:id/errors/export")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "migration_job" })
  @ApiProduces("text/csv")
  @ApiOkResponse({ schema: { type: "string" }, description: "CSV, pemisah ;" })
  async errorsCsv(@Ctx() ctx: RequestContext, @Param() p: ImportIdParamDto, @Res() res: Response): Promise<void> {
    const { fileName, csv } = await this.imports.errorsCsv(ctx, p.id);
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${fileName}"`);
    res.setHeader("cache-control", "private, no-store");
    res.send(csv);
  }

  @Get("presets")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "migration_preset" })
  @ZodResponse({ type: PresetListDto })
  async presets(@Ctx() ctx: RequestContext) {
    return { items: (await this.imports.presets(ctx)).map(presetView) };
  }

  @Post("presets")
  @HttpCode(201)
  @RequirePermission("settings:store")
  @Isolation("self")
  @ZodResponse({ type: PresetDto, status: 201 })
  async savePreset(@Ctx() ctx: RequestContext, @Body() body: SavePresetDto) {
    return presetView(await this.imports.savePreset(ctx, body));
  }

  @Delete("presets/:id")
  @HttpCode(204)
  @RequirePermission("settings:store")
  @Isolation({ fixture: "migration_preset" })
  async deletePreset(@Ctx() ctx: RequestContext, @Param() p: PresetIdParamDto): Promise<void> {
    await this.imports.deletePreset(ctx, p.id);
  }
}

/** L46 Migrasi Data, steps 4 and 5 (FR-MIG-05, 06): parallel mode side by side, checklist, cutover. */
@ApiTags("migration")
@Controller("v1/migration")
export class MigrationCutoverController {
  constructor(
    @Inject(ParallelModeService) private readonly parallel: ParallelModeService,
    @Inject(CutoverService) private readonly cutovers: CutoverService,
  ) {}

  /** Every connected store: since when in parallel mode, orders received, stock of both systems, checklist. */
  @Get("parallel")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: StoreStateListDto })
  async summary(@Ctx() ctx: RequestContext) {
    return { items: (await this.parallel.summary(ctx)).map((s) => storeStateView(s)) };
  }

  /** Per listing: the marketplace's stock against what OmniSeller would send, worst first. */
  @Get("stores/:id/stock-comparison")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: StockComparisonDto })
  async comparison(@Ctx() ctx: RequestContext, @Param() p: StoreIdParamDto, @Query() q: ComparisonQueryDto) {
    return comparisonView(await this.parallel.comparisonOf(ctx, p.id), q);
  }

  @Get("cutover-check")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: StoreStateListDto })
  async check(@Ctx() ctx: RequestContext, @Query() q: CutoverCheckQueryDto) {
    return { items: (await this.cutovers.check(ctx, q.storeId)).map((s) => storeStateView(s)) };
  }

  /** "Pindah sepenuhnya ke OmniSeller": every store passes its checklist, or none moves (409 with the reasons). */
  @Post("cutover")
  @HttpCode(200)
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: CutoverListDto })
  async cutover(@Ctx() ctx: RequestContext, @Body() body: CutoverRequestDto) {
    return { items: (await this.cutovers.cutover(ctx, body)).map((c) => cutoverView(c)) };
  }

  @Get("cutovers")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store_cutover" })
  @ZodResponse({ type: CutoverListDto })
  async list(@Ctx() ctx: RequestContext) {
    return { items: (await this.cutovers.list(ctx)).map((c) => cutoverView(c)) };
  }

  /** Back to parallel mode, within 24 hours of the cutover. */
  @Post("cutovers/:id/undo")
  @HttpCode(200)
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store_cutover" })
  @ZodResponse({ type: CutoverDto })
  async undo(@Ctx() ctx: RequestContext, @Param() p: CutoverIdParamDto) {
    return cutoverView(await this.cutovers.undo(ctx, p.id));
  }
}
