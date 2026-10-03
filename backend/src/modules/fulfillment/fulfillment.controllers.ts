import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { ActionResultsDto, actionView } from "../orders/dto";
import {
  ArrangeShipmentsDto,
  DocumentDto,
  DocumentIdParamDto,
  documentView,
  LabelsQueuedDto,
  OrderIdParamDto,
  OrderLabelsDto,
  PickListDto,
  PickListRequestDto,
  pickListView,
  RequestDocumentDto,
  ShipmentListDto,
  shipmentView,
} from "./dto";
import { FulfillmentService } from "./fulfillment.service";

@ApiTags("shipments")
@Controller("v1")
export class ShipmentsController {
  constructor(@Inject(FulfillmentService) private readonly fulfillment: FulfillmentService) {}

  /**
   * "Atur pengiriman" (FR-SHP-06, FR-ORD-08): pickup or drop-off for many orders at once; new orders are
   * accepted on the way ("Proses semua yang baru"). Results per order; the worker arranges at the
   * marketplace and fetches the labels.
   */
  @Post("shipments/arrange")
  @HttpCode(200)
  @RequirePermission("shipment:arrange")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: ActionResultsDto })
  async arrange(@Ctx() ctx: RequestContext, @Body() body: ArrangeShipmentsDto) {
    return { items: (await this.fulfillment.arrange(ctx, body.orderIds, body.method)).map(actionView) };
  }

  /** Fetches the labels of arranged shipments again (the worker retries on its own for about 30 minutes). */
  @Post("shipments/labels")
  @HttpCode(202)
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: LabelsQueuedDto, status: 202 })
  async labels(@Ctx() ctx: RequestContext, @Body() body: OrderLabelsDto) {
    return { queued: await this.fulfillment.requestLabels(ctx, body.orderIds) };
  }

  /** L04: the order's shipments, packages, tracking numbers, and labels. */
  @Get("orders/:id/shipments")
  @RequirePermission("order:read")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: ShipmentListDto })
  async ofOrder(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto) {
    return { items: (await this.fulfillment.shipmentsOf(ctx, [p.id])).map(shipmentView) };
  }
}

@ApiTags("documents")
@Controller("v1")
export class DocumentsController {
  constructor(@Inject(FulfillmentService) private readonly fulfillment: FulfillmentService) {}

  /** L07: labels in one PDF (thermal or A4, in pick-list order) or the pick list; rendered by the worker. */
  @Post("documents")
  @HttpCode(202)
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: DocumentDto, status: 202 })
  async create(@Ctx() ctx: RequestContext, @Body() body: RequestDocumentDto) {
    return documentView(await this.fulfillment.requestDocument(ctx, body.kind, body.orderIds, body.format));
  }

  @Get("documents/:id")
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "document" })
  @ZodResponse({ type: DocumentDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: DocumentIdParamDto) {
    return documentView(await this.fulfillment.document(ctx, p.id));
  }

  /** L05 "Daftar ambil" (FR-SHP-02): units per SKU and warehouse, sorted by rack. */
  @Post("pick-lists")
  @HttpCode(200)
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: PickListDto })
  async pickList(@Ctx() ctx: RequestContext, @Body() body: PickListRequestDto) {
    return pickListView(await this.fulfillment.pickList(ctx, body.orderIds));
  }
}
