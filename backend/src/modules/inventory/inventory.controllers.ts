import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ulidSchema } from "@omniseller/shared";
import type { Response } from "express";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import type { AuthedRequest } from "../../common/http/request";
import { AllocationRulesService } from "./allocation-rules.service";
import {
  AdjustmentResultDto,
  AdjustStockDto,
  adjustmentView,
  CreateRuleDto,
  InitialStockDto,
  InitialStockResultDto,
  InventoryLocationDto,
  InventoryLocationParamDto,
  InventoryRowDto,
  initialLineView,
  inventoryRowView,
  MovementPageDto,
  MovementQueryDto,
  movementView,
  ResyncStockDto,
  RuleDto,
  RuleIdParamDto,
  RuleListDto,
  RuleQueryDto,
  ruleView,
  StockPageDto,
  StockQueryDto,
  StockSummaryDto,
  StockSummaryQueryDto,
  stockItemView,
  UpdateRuleDto,
} from "./dto";
import { InitialStockService } from "./initial-stock.service";
import { InventoryService } from "./inventory.service";
import { StockOverviewService } from "./stock-overview.service";
import { WarehousesService } from "./warehouses.service";

function nextCursor(lastId: string | undefined, more: boolean): string | null {
  return more && lastId ? encodeCursor(lastId) : null;
}

const warehouseSchema = z.object({
  id: ulidSchema,
  code: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  active: z.boolean(),
  address: z.record(z.string(), z.unknown()),
});
export class WarehouseListDto extends createZodDto(z.object({ items: z.array(warehouseSchema) })) {}

@ApiTags("warehouses")
@Controller("v1/warehouses")
@RequirePermission("inventory:read")
export class WarehousesController {
  constructor(@Inject(WarehousesService) private readonly warehouses: WarehousesService) {}

  /** Warehouses of the business, limited to the caller's warehouse scope. */
  @Get()
  @Isolation({ fixture: "warehouse" })
  @ZodResponse({ type: WarehouseListDto })
  async list(@Ctx() ctx: RequestContext) {
    return { items: await this.warehouses.list(ctx) };
  }
}

@ApiTags("inventory")
@Controller("v1/inventory")
export class InventoryController {
  constructor(
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(StockOverviewService) private readonly overview: StockOverviewService,
    @Inject(InitialStockService) private readonly initial: InitialStockService,
    @Inject(AllocationRulesService) private readonly rules: AllocationRulesService,
  ) {}

  /** L19: stock per variant and warehouse, with the push state per store. */
  @Get()
  @RequirePermission("inventory:read")
  @Isolation({ fixture: "variant" })
  @ZodResponse({ type: StockPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: StockQueryDto) {
    const page = await this.overview.list(
      ctx,
      { q: q.q, warehouseId: q.warehouseId, stock: q.stock, includeArchived: q.includeArchived === "true" },
      decodeCursor(q.cursor),
      q.limit,
    );
    const items = page.items.map(stockItemView);
    return { items, next_cursor: nextCursor(items[items.length - 1]?.id, page.more) };
  }

  @Get("summary")
  @RequirePermission("inventory:read")
  @Isolation("self")
  @ZodResponse({ type: StockSummaryDto })
  async summary(@Ctx() ctx: RequestContext, @Query() q: StockSummaryQueryDto) {
    return this.inventory.summary(ctx, q.warehouseId);
  }

  /** FR-STK-06: stock card. */
  @Get("movements")
  @RequirePermission("inventory:read")
  @Isolation({ fixture: "stock_movement" })
  @ZodResponse({ type: MovementPageDto })
  async movements(@Ctx() ctx: RequestContext, @Query() q: MovementQueryDto) {
    const page = await this.inventory.movements(
      ctx,
      { variantId: q.variantId, warehouseId: q.warehouseId, type: q.type },
      decodeCursor(q.cursor),
      q.limit,
    );
    const items = page.items.map(movementView);
    return { items, next_cursor: nextCursor(items[items.length - 1]?.id, page.more) };
  }

  /** FR-STK-05: all lines or none; the reason is required. */
  @Post("adjustments")
  @HttpCode(200)
  @RequirePermission("inventory:adjust")
  @Isolation({ fixture: "variant" })
  @ZodResponse({ type: AdjustmentResultDto })
  async adjust(@Ctx() ctx: RequestContext, @Body() body: AdjustStockDto) {
    const results = await this.inventory.adjust(ctx, { lines: body.lines, reason: body.reason, note: body.note });
    return { items: results.map(adjustmentView) };
  }

  /** Initial stock from a connected store's last pull; only stock nobody has set yet. */
  @Post("initial-stock")
  @HttpCode(200)
  @RequirePermission("inventory:adjust")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: InitialStockResultDto })
  async initialStock(@Ctx() ctx: RequestContext, @Body() body: InitialStockDto) {
    const r = await this.initial.fromStore(ctx, body.storeId, body.dryRun);
    return { ...r, lines: r.lines.map(initialLineView) };
  }

  /** Sends every stock value of a live store again (202). */
  @Post("resync")
  @HttpCode(202)
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  async resync(@Ctx() ctx: RequestContext, @Body() body: ResyncStockDto): Promise<void> {
    await this.rules.requestResync(ctx, body.storeId);
  }

  @Put(":variantId/warehouses/:warehouseId")
  @RequirePermission("inventory:adjust")
  @Isolation({ fixture: "variant" })
  @ZodResponse({ type: InventoryRowDto })
  async setLocation(
    @Ctx() ctx: RequestContext,
    @Param() p: InventoryLocationParamDto,
    @Body() body: InventoryLocationDto,
  ) {
    return inventoryRowView(await this.inventory.setLocation(ctx, p.variantId, p.warehouseId, body));
  }
}

@ApiTags("inventory")
@Controller("v1/stock-allocation-rules")
@RequirePermission("settings:store")
export class StockRulesController {
  constructor(@Inject(AllocationRulesService) private readonly rules: AllocationRulesService) {}

  @Get()
  @Isolation({ fixture: "stock_rule" })
  @ZodResponse({ type: RuleListDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: RuleQueryDto) {
    return { items: (await this.rules.list(ctx, q.storeId)).map(ruleView) };
  }

  @Post()
  @Isolation({ fixture: "store" })
  @ZodResponse({ status: 201, type: RuleDto })
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateRuleDto) {
    return ruleView(await this.rules.create(ctx, body));
  }

  @Get(":id")
  @Isolation({ fixture: "stock_rule" })
  @ZodResponse({ type: RuleDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: RuleIdParamDto, @Res({ passthrough: true }) res: Response) {
    const rule = await this.rules.get(ctx, p.id);
    res.setHeader("ETag", `"${rule.rowVersion}"`);
    return ruleView(rule);
  }

  @Patch(":id")
  @Isolation({ fixture: "stock_rule" })
  @ZodResponse({ type: RuleDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param() p: RuleIdParamDto,
    @Body() body: UpdateRuleDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rule = await this.rules.update(ctx, p.id, body, parseIfMatch(req));
    res.setHeader("ETag", `"${rule.rowVersion}"`);
    return ruleView(rule);
  }

  @Delete(":id")
  @HttpCode(204)
  @Isolation({ fixture: "stock_rule" })
  async remove(@Ctx() ctx: RequestContext, @Param() p: RuleIdParamDto): Promise<void> {
    await this.rules.remove(ctx, p.id);
  }
}
