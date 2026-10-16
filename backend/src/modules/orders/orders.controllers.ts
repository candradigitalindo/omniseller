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
import { ApiHeader, ApiTags } from "@nestjs/swagger";
import type { OrderStatus } from "@omniseller/shared";
import { isUlid } from "@omniseller/shared";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { ValidationError } from "../../common/errors/domain-errors";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import type { AuthedRequest } from "../../common/http/request";
import { idempotencyKey } from "../../common/idempotency";
import {
  ActionResultsDto,
  actionView,
  CancelOrderDto,
  CancelReasonsDto,
  ChangeWarehouseDto,
  CourierListDto,
  CourierQueryDto,
  CreateManualOrderDto,
  CreateTagDto,
  OrderDto,
  OrderIdParamDto,
  OrderIdsDto,
  OrderNoteDto,
  OrderPageDto,
  OrderProblemParamDto,
  OrderQueryDto,
  OrderSummaryDto,
  OrderSummaryQueryDto,
  OrderSyncDto,
  OrderTagsDto,
  OrderTagsResultDto,
  orderDetailView,
  orderListView,
  orderTagsView,
  PayOrderDto,
  ResolveProblemDto,
  ShipOrderDto,
  TagDto,
  TagIdParamDto,
  TagListDto,
  tagView,
  UpdateManualOrderDto,
  UpdateTagDto,
} from "./dto";
import { ManualOrdersService } from "./manual-orders.service";
import { SLA_WARNING_MS } from "./order-plan";
import type { ShipByCursor } from "./orders.repository";
import { OrdersService } from "./orders.service";
import { TagsService } from "./tags.service";

/** The deadline the queue sorts by: the courier's cut-off or the marketplace's, whichever comes first. */
function deadlineOf(o: { shipByAt: Date | null; internalShipByAt: Date | null }): Date | null {
  if (!o.shipByAt || !o.internalShipByAt) return o.shipByAt ?? o.internalShipByAt;
  return o.internalShipByAt < o.shipByAt ? o.internalShipByAt : o.shipByAt;
}

function decodeShipBy(cursor: string | undefined): ShipByCursor | undefined {
  if (!cursor) return undefined;
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as ShipByCursor;
    if (isUlid(c.id) && (c.t === null || Number.isFinite(c.t))) return c;
  } catch {}
  throw new ValidationError([{ path: "cursor", message: "Cursor tidak valid." }]);
}

@ApiTags("orders")
@Controller("v1/orders")
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(ManualOrdersService) private readonly manual: ManualOrdersService,
    @Inject(TagsService) private readonly tags: TagsService,
  ) {}

  /** L03: the unified queue (FR-ORD-02, 03, 07, 15). `sort=ship_by` puts the most urgent first. */
  @Get()
  @RequirePermission("order:read")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: OrderPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: OrderQueryDto) {
    const now = Date.now();
    const page = await this.orders.list(
      ctx,
      {
        storeId: q.storeId,
        channel: q.channel,
        courier: q.courier,
        statuses: q.status ? (q.status.split(",").map((s) => s.trim()) as OrderStatus[]) : undefined,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        q: q.q,
        warehouseId: q.warehouseId,
        problem: q.problem,
        cod: q.cod === undefined ? undefined : q.cod === "true",
        dueBefore: q.due === "overdue" ? new Date(now) : q.due === "soon" ? new Date(now + SLA_WARNING_MS) : undefined,
        cutoffToday: q.due === "cutoff",
        tagId: q.tagId,
      },
      q.sort,
      q.sort === "ship_by" ? decodeShipBy(q.cursor) : decodeCursor(q.cursor),
      q.limit,
    );
    const last = page.items[page.items.length - 1]?.order;
    const next =
      page.more && last
        ? q.sort === "ship_by"
          ? Buffer.from(JSON.stringify({ t: deadlineOf(last)?.getTime() ?? null, id: last.id })).toString("base64url")
          : encodeCursor(last.id)
        : null;
    return { items: page.items.map((v) => orderListView(v)), next_cursor: next };
  }

  /** Tab counters, almost-late and overdue counts, COD not yet received. */
  @Get("summary")
  @RequirePermission("order:read")
  @Isolation("self")
  @ZodResponse({ type: OrderSummaryDto })
  async summary(@Ctx() ctx: RequestContext, @Query() q: OrderSummaryQueryDto) {
    return this.orders.summary(ctx, { storeId: q.storeId, warehouseId: q.warehouseId });
  }

  /** FR-ORD-08 "Terima": new to ready to pack, per order. */
  /** Couriers of recent orders, for the cut-off form (UI L43, backend doc 8.31). */
  @Get("couriers")
  @RequirePermission("order:read")
  @Isolation("self")
  @ZodResponse({ type: CourierListDto })
  async couriers(@Ctx() ctx: RequestContext, @Query() q: CourierQueryDto) {
    return { items: await this.orders.recentCouriers(ctx, q.warehouseId), next_cursor: null };
  }

  @Post("accept")
  @HttpCode(200)
  @RequirePermission("order:accept")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: ActionResultsDto })
  async accept(@Ctx() ctx: RequestContext, @Body() body: OrderIdsDto) {
    return { items: (await this.orders.accept(ctx, body.orderIds)).map(actionView) };
  }

  /** FR-ORD-08 "Tandai dikemas": ready to pack to packed, per order. */
  @Post("pack")
  @HttpCode(200)
  @RequirePermission("shipment:pack")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: ActionResultsDto })
  async pack(@Ctx() ctx: RequestContext, @Body() body: OrderIdsDto) {
    return { items: (await this.orders.pack(ctx, body.orderIds)).map(actionView) };
  }

  /**
   * FR-ORD-09: a sale outside marketplaces (WhatsApp, Instagram, a counter) in the same queue; its stock
   * is reserved at once. With Idempotency-Key a repeated request returns the first order.
   */
  @Post("manual")
  @RequirePermission("order:write")
  @Isolation({ fixture: "store" })
  @ApiHeader({ name: "Idempotency-Key", required: false, description: "8-100 karakter; mencegah pesanan ganda" })
  @ZodResponse({ status: 201, type: OrderDto })
  async createManual(
    @Ctx() ctx: RequestContext,
    @Body() body: CreateManualOrderDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req.header("idempotency-key"));
    const { orderId, created } = await this.manual.create(
      ctx,
      { ...body, orderedAt: body.orderedAt ? new Date(body.orderedAt) : undefined },
      key,
    );
    if (!created) res.setHeader("Idempotent-Replayed", "true");
    return orderDetailView(ctx, await this.orders.get(ctx, orderId));
  }

  /** FR-ORD-04: puts tags on and takes tags off many orders; returns each order's tags. */
  @Post("tags")
  @HttpCode(200)
  @RequirePermission("order:tag")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: OrderTagsResultDto })
  async setTags(@Ctx() ctx: RequestContext, @Body() body: OrderTagsDto) {
    return { items: (await this.tags.assign(ctx, body)).map(orderTagsView) };
  }

  /** Reads a store's orders again from the marketplace (202). */
  @Post("sync")
  @HttpCode(202)
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  async sync(@Ctx() ctx: RequestContext, @Body() body: OrderSyncDto): Promise<void> {
    await this.orders.requestSync(ctx, body.storeId);
  }

  /** L04: items, amounts, address, problems, and the activity history (FR-ORD-05, 14). */
  @Get(":id")
  @RequirePermission("order:read")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: OrderDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto) {
    return orderDetailView(ctx, await this.orders.get(ctx, p.id));
  }

  /** A manual order's buyer, address, courier, tracking number, buyer's note. */
  @Patch(":id")
  @RequirePermission("order:write")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: OrderDto })
  async updateManual(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto, @Body() body: UpdateManualOrderDto) {
    await this.manual.update(ctx, p.id, body);
    return orderDetailView(ctx, await this.orders.get(ctx, p.id));
  }

  /** "Tandai dibayar": a manual order waiting for transfer becomes new. */
  @Post(":id/pay")
  @HttpCode(200)
  @RequirePermission("order:write")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: OrderDto })
  async pay(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto, @Body() body: PayOrderDto) {
    await this.manual.markPaid(ctx, p.id, body.paidAt ? new Date(body.paidAt) : undefined);
    return orderDetailView(ctx, await this.orders.get(ctx, p.id));
  }

  /** "Kirim": a manual order handed to the courier, with the tracking number. */
  @Post(":id/ship")
  @HttpCode(200)
  @RequirePermission("shipment:handover")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: OrderDto })
  async ship(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto, @Body() body: ShipOrderDto) {
    await this.manual.ship(ctx, p.id, body);
    return orderDetailView(ctx, await this.orders.get(ctx, p.id));
  }

  /** "Selesai": a manual order the buyer received (or picked up). */
  @Post(":id/complete")
  @HttpCode(200)
  @RequirePermission("order:write")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: OrderDto })
  async complete(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto) {
    await this.manual.complete(ctx, p.id);
    return orderDetailView(ctx, await this.orders.get(ctx, p.id));
  }

  /** FR-ORD-12: another warehouse for an order not packed yet, unless a marketplace placed it (409). */
  @Put(":id/warehouse")
  @HttpCode(204)
  @RequirePermission("order:accept")
  @Isolation({ fixture: "order" })
  async changeWarehouse(
    @Ctx() ctx: RequestContext,
    @Param() p: OrderIdParamDto,
    @Body() body: ChangeWarehouseDto,
  ): Promise<void> {
    await this.orders.changeWarehouse(ctx, p.id, body.warehouseId);
  }

  @Get(":id/cancel-reasons")
  @RequirePermission("order:cancel")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: CancelReasonsDto })
  async cancelReasons(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto) {
    return { items: await this.orders.cancelReasons(ctx, p.id) };
  }

  /** FR-ORD-13: cancels at the marketplace through the worker; stock returns with its answer (202). */
  @Post(":id/cancel")
  @HttpCode(202)
  @RequirePermission("order:cancel")
  @Isolation({ fixture: "order" })
  async cancel(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto, @Body() body: CancelOrderDto): Promise<void> {
    await this.orders.requestCancel(ctx, p.id, body.reason);
  }

  /** FR-ORD-10: internal note. */
  @Put(":id/note")
  @HttpCode(204)
  @RequirePermission("order:tag")
  @Isolation({ fixture: "order" })
  async note(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto, @Body() body: OrderNoteDto): Promise<void> {
    await this.orders.setNote(ctx, p.id, body.note);
  }

  @Post(":id/problems/:problemId/resolve")
  @HttpCode(204)
  @RequirePermission("order:accept")
  @Isolation({ fixture: "order" })
  async resolveProblem(
    @Ctx() ctx: RequestContext,
    @Param() p: OrderProblemParamDto,
    @Body() body: ResolveProblemDto,
  ): Promise<void> {
    await this.orders.resolveProblem(ctx, p.id, p.problemId, body.resolution ?? null);
  }
}

/** FR-ORD-04: the business's order tags ("prioritas", "fragile", "COD", ...). */
@ApiTags("orders")
@Controller("v1/tags")
export class TagsController {
  constructor(@Inject(TagsService) private readonly tags: TagsService) {}

  @Get()
  @RequirePermission("order:read")
  @Isolation({ fixture: "tag" })
  @ZodResponse({ type: TagListDto })
  async list(@Ctx() ctx: RequestContext) {
    return { items: (await this.tags.list(ctx)).map(tagView) };
  }

  @Post()
  @RequirePermission("order:tag")
  @Isolation("self")
  @ZodResponse({ status: 201, type: TagDto })
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateTagDto) {
    return tagView(await this.tags.create(ctx, body));
  }

  @Patch(":id")
  @RequirePermission("order:tag")
  @Isolation({ fixture: "tag" })
  @ZodResponse({ type: TagDto })
  async update(@Ctx() ctx: RequestContext, @Param() p: TagIdParamDto, @Body() body: UpdateTagDto) {
    return tagView(await this.tags.update(ctx, p.id, body));
  }

  /** Takes the tag off every order and deletes it. */
  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("order:tag")
  @Isolation({ fixture: "tag" })
  async remove(@Ctx() ctx: RequestContext, @Param() p: TagIdParamDto): Promise<void> {
    await this.tags.remove(ctx, p.id);
  }
}
