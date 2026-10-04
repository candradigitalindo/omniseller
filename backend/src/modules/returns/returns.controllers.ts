import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import {
  AcceptReturnDto,
  AddEvidenceDto,
  EvidenceDto,
  ReceiveReturnDto,
  RefreshReturnDto,
  RejectReturnDto,
  ReturnDto,
  ReturnIdParamDto,
  ReturnPageDto,
  ReturnQueryDto,
  ReturnSummaryDto,
  ReturnSummaryQueryDto,
  returnView,
} from "./dto";
import { ReturnsService } from "./returns.service";

/**
 * UI L09 "Retur & Batal" (PRD FR-RET-01..07, backend doc 8.26): buyers' return, refund, and cancellation
 * requests with their deadlines, the seller's decisions, and returned goods received into stock or
 * quarantine, including parcels of orders cancelled after shipping (RTO).
 */
@ApiTags("returns")
@Controller("v1/returns")
export class ReturnsController {
  constructor(@Inject(ReturnsService) private readonly returns: ReturnsService) {}

  /** Newest first; `awaitingDecision`, `toReceive`, and `group` give the screen's tabs. */
  @Get()
  @RequirePermission("order:read")
  @Isolation({ fixture: "return_request" })
  @ZodResponse({ type: ReturnPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: ReturnQueryDto) {
    const page = await this.returns.list(
      ctx,
      {
        group: q.group,
        status: q.status,
        awaitingDecision: q.awaitingDecision === "true",
        toReceive: q.toReceive === "true",
        storeId: q.storeId,
        warehouseId: q.warehouseId,
        orderId: q.orderId,
      },
      decodeCursor(q.cursor),
      q.limit,
    );
    const last = page.items[page.items.length - 1];
    return {
      items: page.items.map(returnView),
      next_cursor: page.more && last ? encodeCursor(last.request.id) : null,
    };
  }

  /** Counters of the tabs: decisions waiting, deadlines within 12 hours, goods to receive. */
  @Get("summary")
  @RequirePermission("order:read")
  @Isolation({ fixture: "return_request" })
  @ZodResponse({ type: ReturnSummaryDto })
  async summary(@Ctx() ctx: RequestContext, @Query() q: ReturnSummaryQueryDto) {
    return this.returns.summary(ctx, { storeId: q.storeId, warehouseId: q.warehouseId });
  }

  @Get(":id")
  @RequirePermission("order:read")
  @Isolation({ fixture: "return_request" })
  @ZodResponse({ type: ReturnDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: ReturnIdParamDto) {
    return returnView(await this.returns.get(ctx, p.id));
  }

  /** Reads the request again from the marketplace, with what the seller may decide (202). */
  @Post(":id/refresh")
  @HttpCode(202)
  @RequirePermission("return:respond")
  @Isolation({ fixture: "return_request" })
  @ZodResponse({ status: 202, type: RefreshReturnDto })
  async refresh(@Ctx() ctx: RequestContext, @Param() p: ReturnIdParamDto) {
    return this.returns.requestRefresh(ctx, p.id);
  }

  /** A photo for a rejection (JPEG or PNG, at most 5 MB, base64), kept privately. */
  @Post(":id/evidence")
  @HttpCode(201)
  @RequirePermission("return:respond")
  @Isolation({ fixture: "return_request" })
  @ZodResponse({ status: 201, type: EvidenceDto })
  async addEvidence(@Ctx() ctx: RequestContext, @Param() p: ReturnIdParamDto, @Body() body: AddEvidenceDto) {
    const e = await this.returns.addEvidence(ctx, p.id, body.content);
    return { fileId: e.fileId, contentType: e.contentType, size: e.size, uploadedAt: e.uploadedAt };
  }

  /** Accepts the request at the marketplace; sent by the worker (`response.status` pending, then sent). */
  @Post(":id/accept")
  @HttpCode(200)
  @RequirePermission("return:respond")
  @Isolation({ fixture: "return_request" })
  @ZodResponse({ type: ReturnDto })
  async accept(@Ctx() ctx: RequestContext, @Param() p: ReturnIdParamDto, @Body() body: AcceptReturnDto) {
    return returnView(await this.returns.respond(ctx, p.id, "accept", body));
  }

  /** Rejects the request (or disputes it, on Shopee) with a reason, a comment, and photos. */
  @Post(":id/reject")
  @HttpCode(200)
  @RequirePermission("return:respond")
  @Isolation({ fixture: "return_request" })
  @ZodResponse({ type: ReturnDto })
  async reject(@Ctx() ctx: RequestContext, @Param() p: ReturnIdParamDto, @Body() body: RejectReturnDto) {
    return returnView(await this.returns.respond(ctx, p.id, "reject", body));
  }

  /**
   * Records the returned goods (FR-RET-03): per item, units sellable (back in stock), damaged
   * (quarantine), and missing. Once per request.
   */
  @Post(":id/receive")
  @HttpCode(200)
  @RequirePermission("return:receive")
  @Isolation({ fixture: "return_request" })
  @ZodResponse({ type: ReturnDto })
  async receive(@Ctx() ctx: RequestContext, @Param() p: ReturnIdParamDto, @Body() body: ReceiveReturnDto) {
    return returnView(await this.returns.receive(ctx, p.id, body));
  }
}
