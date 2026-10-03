import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { OrderStatus } from "@omniseller/shared";
import { isUlid } from "@omniseller/shared";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { ValidationError } from "../../common/errors/domain-errors";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import {
  ActionResultsDto,
  actionView,
  CancelOrderDto,
  CancelReasonsDto,
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
  orderDetailView,
  orderListView,
  ResolveProblemDto,
} from "./dto";
import { SLA_WARNING_MS } from "./order-plan";
import type { ShipByCursor } from "./orders.repository";
import { OrdersService } from "./orders.service";

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
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

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
        statuses: q.status ? (q.status.split(",").map((s) => s.trim()) as OrderStatus[]) : undefined,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        q: q.q,
        warehouseId: q.warehouseId,
        problem: q.problem,
        cod: q.cod === undefined ? undefined : q.cod === "true",
        dueBefore: q.due === "overdue" ? new Date(now) : q.due === "soon" ? new Date(now + SLA_WARNING_MS) : undefined,
      },
      q.sort,
      q.sort === "ship_by" ? decodeShipBy(q.cursor) : decodeCursor(q.cursor),
      q.limit,
    );
    const last = page.items[page.items.length - 1]?.order;
    const next =
      page.more && last
        ? q.sort === "ship_by"
          ? Buffer.from(JSON.stringify({ t: last.shipByAt?.getTime() ?? null, id: last.id })).toString("base64url")
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
