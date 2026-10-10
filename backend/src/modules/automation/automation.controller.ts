import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import type { AuthedRequest } from "../../common/http/request";
import { IdParamDto } from "../identity/dto";
import {
  CreateOrderRuleDto,
  OrderRuleDto,
  OrderRuleListDto,
  orderRuleDto,
  ReorderOrderRulesDto,
  UpdateOrderRuleDto,
} from "./dto";
import { OrderRulesService } from "./order-rules.service";

/**
 * Aturan Otomatis (UI L55, PRD FR-ORD-19, backend doc 8.37): who may accept orders keeps the rules that
 * process new orders; made, changed, and reordered from plan Growth on (422 `billing.feature_unavailable`).
 */
@ApiTags("order-rules")
@Controller("v1/order-rules")
@RequirePermission("order:accept")
export class OrderRulesController {
  constructor(@Inject(OrderRulesService) private readonly rules: OrderRulesService) {}

  @Get()
  @Isolation({ fixture: "order_rule" })
  @ZodResponse({ type: OrderRuleListDto })
  async list(@Ctx() ctx: RequestContext) {
    return { items: (await this.rules.list(ctx)).map(orderRuleDto), next_cursor: null };
  }

  @Post()
  @Isolation({ fixture: "store" })
  @ZodResponse({ status: 201, type: OrderRuleDto })
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateOrderRuleDto) {
    return orderRuleDto(await this.rules.create(ctx, body));
  }

  /** The order rules are checked in: every rule the caller manages, first checked first. */
  @Put("priority")
  @Isolation({ fixture: "order_rule" })
  @ZodResponse({ type: OrderRuleListDto })
  async reorder(@Ctx() ctx: RequestContext, @Body() body: ReorderOrderRulesDto) {
    return { items: (await this.rules.reorder(ctx, body.ids)).map(orderRuleDto), next_cursor: null };
  }

  @Patch(":id")
  @Isolation({ fixture: "order_rule" })
  @ZodResponse({ type: OrderRuleDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param() p: IdParamDto,
    @Body() body: UpdateOrderRuleDto,
    @Req() req: AuthedRequest,
  ) {
    return orderRuleDto(await this.rules.update(ctx, p.id, body, parseIfMatch(req)));
  }

  @Delete(":id")
  @HttpCode(204)
  @Isolation({ fixture: "order_rule" })
  async remove(@Ctx() ctx: RequestContext, @Param() p: IdParamDto): Promise<void> {
    await this.rules.remove(ctx, p.id);
  }
}
