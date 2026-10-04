import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res } from "@nestjs/common";
import { ApiHeader, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import type { AuthedRequest } from "../../common/http/request";
import { idempotencyKey } from "../../common/idempotency";
import { StockCountService } from "./stock-count.service";
import {
  ApplyStockCountDto,
  CreateStockCountDto,
  CreateStockTransferDto,
  countLineView,
  ReceiveStockTransferDto,
  RecordCountDto,
  ScanCountDto,
  ScanCountResultDto,
  StockCountDto,
  StockCountIdParamDto,
  StockCountLinePageDto,
  StockCountLinesDto,
  StockCountLinesQueryDto,
  StockCountPageDto,
  StockCountQueryDto,
  StockTransferDto,
  StockTransferIdParamDto,
  StockTransferPageDto,
  StockTransferQueryDto,
  stockCountView,
  stockTransferView,
  TransferDestinationsDto,
  UpdateStockTransferDto,
} from "./stock-ops.dto";
import { StockTransferService } from "./stock-transfer.service";

/**
 * Stock counts (stock opname, PRD FR-STK-08, backend doc 8.27): started by warehouse staff, counted by
 * hand or by scanning, blind until sent for review, approved by someone holding `inventory:adjust`, and
 * applied by the worker.
 */
@ApiTags("stock-counts")
@Controller("v1/stock-counts")
export class StockCountsController {
  constructor(@Inject(StockCountService) private readonly counts: StockCountService) {}

  /** Lists the warehouse's SKUs (all, or chosen variants and racks) to be counted. One open count per warehouse. */
  @Post()
  @RequirePermission("inventory:count")
  @Isolation({ fixture: "stock_count" })
  @ZodResponse({ status: 201, type: StockCountDto })
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateStockCountDto) {
    return stockCountView(await this.counts.create(ctx, body));
  }

  @Get()
  @RequirePermission("inventory:read")
  @Isolation({ fixture: "stock_count" })
  @ZodResponse({ type: StockCountPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: StockCountQueryDto) {
    const page = await this.counts.list(
      ctx,
      { status: q.status, warehouseId: q.warehouseId },
      decodeCursor(q.cursor),
      q.limit,
    );
    const last = page.items[page.items.length - 1];
    return {
      items: page.items.map(stockCountView),
      next_cursor: page.more && last ? encodeCursor(last.count.id) : null,
    };
  }

  /** With the difference in units and at cost price once counting is over. */
  @Get(":id")
  @RequirePermission("inventory:read")
  @Isolation({ fixture: "stock_count" })
  @ZodResponse({ type: StockCountDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: StockCountIdParamDto) {
    return stockCountView(await this.counts.get(ctx, p.id));
  }

  /** Lines in walking order (rack, then SKU; found lines last); the cursor continues after the last line. */
  @Get(":id/lines")
  @RequirePermission("inventory:read")
  @Isolation({ fixture: "stock_count" })
  @ZodResponse({ type: StockCountLinePageDto })
  async lines(@Ctx() ctx: RequestContext, @Param() p: StockCountIdParamDto, @Query() q: StockCountLinesQueryDto) {
    const page = await this.counts.lines(ctx, p.id, { filter: q.filter, q: q.q }, decodeCursor(q.cursor), q.limit);
    const last = page.items[page.items.length - 1];
    return {
      items: page.items.map((d) => countLineView(d, page.hidden)),
      next_cursor: page.more && last ? encodeCursor(last.line.id) : null,
    };
  }

  /** Counted quantities: `set` what is on the shelf, or `add` scanned units. SKUs not on the list join it. */
  @Put(":id/lines")
  @RequirePermission("inventory:count")
  @Isolation({ fixture: "stock_count" })
  @ZodResponse({ type: StockCountLinesDto })
  async record(@Ctx() ctx: RequestContext, @Param() p: StockCountIdParamDto, @Body() body: RecordCountDto) {
    const page = await this.counts.record(ctx, p.id, body.lines);
    return { items: page.items.map((d) => countLineView(d, page.hidden)) };
  }

  /** One scan of a barcode or SKU: `qty` units (1 by default) added to its line. */
  @Post(":id/scan")
  @HttpCode(200)
  @RequirePermission("inventory:count")
  @Isolation({ fixture: "stock_count" })
  @ZodResponse({ type: ScanCountResultDto })
  async scan(@Ctx() ctx: RequestContext, @Param() p: StockCountIdParamDto, @Body() body: ScanCountDto) {
    const r = await this.counts.scan(ctx, p.id, body.code, body.qty);
    return { matchedBy: r.matchedBy, line: countLineView(r.line, r.hidden) };
  }

  /** Counting is over: the count waits for approval (its numbers become visible). */
  @Post(":id/submit")
  @HttpCode(200)
  @RequirePermission("inventory:count")
  @Isolation({ fixture: "stock_count" })
  @ZodResponse({ type: StockCountDto })
  async submit(@Ctx() ctx: RequestContext, @Param() p: StockCountIdParamDto) {
    return stockCountView(await this.counts.submit(ctx, p.id));
  }

  /** Back to counting, to count some lines again. */
  @Post(":id/reopen")
  @HttpCode(200)
  @RequirePermission("inventory:adjust")
  @Isolation({ fixture: "stock_count" })
  @ZodResponse({ type: StockCountDto })
  async reopen(@Ctx() ctx: RequestContext, @Param() p: StockCountIdParamDto) {
    return stockCountView(await this.counts.reopen(ctx, p.id));
  }

  /**
   * Approves the count; the worker moves the stock (202) and marks it applied. Asking again after a
   * failure continues where it stopped.
   */
  @Post(":id/apply")
  @HttpCode(202)
  @RequirePermission("inventory:adjust")
  @Isolation({ fixture: "stock_count" })
  @ZodResponse({ status: 202, type: StockCountDto })
  async apply(@Ctx() ctx: RequestContext, @Param() p: StockCountIdParamDto, @Body() body: ApplyStockCountDto) {
    return stockCountView(await this.counts.requestApply(ctx, p.id, body));
  }

  /** Stops the count before approval; stock does not change. */
  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("inventory:adjust")
  @Isolation({ fixture: "stock_count" })
  @ZodResponse({ type: StockCountDto })
  async cancel(@Ctx() ctx: RequestContext, @Param() p: StockCountIdParamDto) {
    return stockCountView(await this.counts.cancel(ctx, p.id));
  }
}

/**
 * Stock transfers between warehouses (PRD FR-STK-09, backend doc 8.27): a draft, sent from the origin
 * (stock leaves it), received at the destination (what arrived goes on hand), or cancelled.
 */
@ApiTags("stock-transfers")
@Controller("v1/stock-transfers")
export class StockTransfersController {
  constructor(@Inject(StockTransferService) private readonly transfers: StockTransferService) {}

  /** A draft from a warehouse the caller holds. With Idempotency-Key a repeated request returns the first. */
  @Post()
  @RequirePermission("inventory:transfer")
  @Isolation({ fixture: "stock_transfer" })
  @ApiHeader({ name: "Idempotency-Key", required: false, description: "8-100 karakter; mencegah transfer ganda" })
  @ZodResponse({ status: 201, type: StockTransferDto })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() body: CreateStockTransferDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req.header("idempotency-key"));
    const { view, created } = await this.transfers.create(ctx, body, key);
    if (!created) res.setHeader("Idempotent-Replayed", "true");
    return stockTransferView(view);
  }

  @Get()
  @RequirePermission("inventory:read")
  @Isolation({ fixture: "stock_transfer" })
  @ZodResponse({ type: StockTransferPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: StockTransferQueryDto) {
    const page = await this.transfers.list(
      ctx,
      { status: q.status, warehouseId: q.warehouseId, direction: q.direction },
      decodeCursor(q.cursor),
      q.limit,
    );
    const last = page.items[page.items.length - 1];
    return {
      items: page.items.map(stockTransferView),
      next_cursor: page.more && last ? encodeCursor(last.transfer.id) : null,
    };
  }

  /** Every active warehouse of the business, including those outside the caller's scope. */
  @Get("destinations")
  @RequirePermission("inventory:transfer")
  @Isolation({ fixture: "warehouse" })
  @ZodResponse({ type: TransferDestinationsDto })
  async destinations(@Ctx() ctx: RequestContext) {
    return { items: await this.transfers.destinations(ctx) };
  }

  @Get(":id")
  @RequirePermission("inventory:read")
  @Isolation({ fixture: "stock_transfer" })
  @ZodResponse({ type: StockTransferDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: StockTransferIdParamDto) {
    return stockTransferView(await this.transfers.get(ctx, p.id));
  }

  /** A draft's destination, note, or lines (replaced as a whole). */
  @Patch(":id")
  @RequirePermission("inventory:transfer")
  @Isolation({ fixture: "stock_transfer" })
  @ApiHeader({ name: "If-Match", required: false, description: 'row_version yang terakhir dilihat, contoh "3"' })
  @ZodResponse({ type: StockTransferDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param() p: StockTransferIdParamDto,
    @Body() body: UpdateStockTransferDto,
    @Req() req: AuthedRequest,
  ) {
    return stockTransferView(await this.transfers.update(ctx, p.id, body, parseIfMatch(req)));
  }

  /** The goods leave the origin; only stock available there can go. */
  @Post(":id/send")
  @HttpCode(200)
  @RequirePermission("inventory:transfer")
  @Isolation({ fixture: "stock_transfer" })
  @ZodResponse({ type: StockTransferDto })
  async send(@Ctx() ctx: RequestContext, @Param() p: StockTransferIdParamDto) {
    return stockTransferView(await this.transfers.send(ctx, p.id));
  }

  /** The goods arrived; lines not named arrived in full. */
  @Post(":id/receive")
  @HttpCode(200)
  @RequirePermission("inventory:transfer")
  @Isolation({ fixture: "stock_transfer" })
  @ZodResponse({ type: StockTransferDto })
  async receive(
    @Ctx() ctx: RequestContext,
    @Param() p: StockTransferIdParamDto,
    @Body() body: ReceiveStockTransferDto,
  ) {
    return stockTransferView(await this.transfers.receive(ctx, p.id, body));
  }

  /** A draft is dropped; a sent transfer's goods go back on hand at the origin. */
  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("inventory:transfer")
  @Isolation({ fixture: "stock_transfer" })
  @ZodResponse({ type: StockTransferDto })
  async cancel(@Ctx() ctx: RequestContext, @Param() p: StockTransferIdParamDto) {
    return stockTransferView(await this.transfers.cancel(ctx, p.id));
  }
}
