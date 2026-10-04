import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from "@nestjs/common";
import { ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { ActionResultsDto, actionView } from "../orders/dto";
import {
  ArrangeShipmentsDto,
  DocumentDto,
  DocumentIdParamDto,
  documentView,
  LabelPreviewQueryDto,
  LabelsQueuedDto,
  LabelTemplateDto,
  labelTemplateView,
  OrderIdParamDto,
  OrderLabelsDto,
  PickListDto,
  PickListRequestDto,
  pickListView,
  RequestDocumentDto,
  ShipmentListDto,
  shipmentView,
  TrackingDto,
  TrackingRefreshDto,
  trackingView,
  UpdateLabelTemplateDto,
} from "./dto";
import { FulfillmentService } from "./fulfillment.service";
import { LabelTemplateService } from "./label-template.service";

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

  /** L04 "Lacak" (FR-SHP-07): the parcel's journey as last read from the marketplace. */
  @Get("orders/:id/tracking")
  @RequirePermission("order:read")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: TrackingDto })
  async tracking(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto) {
    return trackingView(await this.fulfillment.tracking(ctx, p.id));
  }

  /** "Perbarui": reads the parcel again through the worker (202), at most every 10 minutes. */
  @Post("orders/:id/tracking/refresh")
  @HttpCode(202)
  @RequirePermission("order:read")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: TrackingRefreshDto, status: 202 })
  async refreshTracking(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto) {
    return { queued: await this.fulfillment.requestTracking(ctx, p.id) };
  }
}

@ApiTags("documents")
@Controller("v1")
export class DocumentsController {
  constructor(
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(LabelTemplateService) private readonly templates: LabelTemplateService,
  ) {}

  /**
   * L07: labels in one PDF (thermal or A4, in pick-list order; custom template and packing lists on
   * request), the pick list, or packing lists; rendered by the worker.
   */
  @Post("documents")
  @HttpCode(202)
  @RequirePermission("shipment:print")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: DocumentDto, status: 202 })
  async create(@Ctx() ctx: RequestContext, @Body() body: RequestDocumentDto) {
    return documentView(
      await this.fulfillment.requestDocument(ctx, body.kind, body.orderIds, {
        format: body.format,
        template: body.template,
        packingList: body.packingList,
      }),
    );
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

  /** L42: what the custom template adds under marketplace labels (FR-SHP-16). */
  @Get("label-template")
  @RequirePermission("shipment:print")
  @Isolation("self")
  @ZodResponse({ type: LabelTemplateDto })
  async labelTemplate(@Ctx() ctx: RequestContext) {
    return labelTemplateView(await this.templates.get(ctx));
  }

  @Put("label-template")
  @RequirePermission("settings:warehouse")
  @Isolation("self")
  @ZodResponse({ type: LabelTemplateDto })
  async setLabelTemplate(@Ctx() ctx: RequestContext, @Body() body: UpdateLabelTemplateDto) {
    return labelTemplateView(await this.templates.set(ctx, body));
  }

  /** L42 "Cetak percobaan": a stand-in marketplace label with the template under it, as PDF. */
  @Get("label-template/preview")
  @RequirePermission("shipment:print")
  @Isolation("self")
  @ApiProduces("application/pdf")
  @ApiOkResponse({ description: "PDF" })
  async previewLabelTemplate(
    @Ctx() ctx: RequestContext,
    @Query() q: LabelPreviewQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const pdf = await this.templates.preview(ctx, q.format);
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", 'inline; filename="contoh-label.pdf"');
    res.setHeader("cache-control", "no-store");
    res.end(Buffer.from(pdf));
  }
}
