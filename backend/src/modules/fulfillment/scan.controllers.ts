import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import { documentView } from "./dto";
import { HandoverService } from "./handover.service";
import { PackingService } from "./packing.service";
import { printJobView } from "./print.dto";
import {
  CompletedHandoverDto,
  CompleteHandoverDto,
  CompletePackingDto,
  HandoverCouriersDto,
  HandoverCouriersQueryDto,
  HandoverDetailDto,
  HandoverDto,
  HandoverIdParamDto,
  HandoverItemParamDto,
  HandoverPageDto,
  HandoverQueryDto,
  HandoverScanDto,
  HandoverScanResultDto,
  handoverItemView,
  handoverView,
  ManifestDocumentDto,
  ManifestRequestDto,
  OpenHandoverDto,
  OrderIdParamDto,
  PackingLookupQueryDto,
  PackingResultDto,
  PackingViewDto,
  packingView,
  scannedOrderView,
} from "./scan.dto";

/** UI L06 "Kemas dengan scan" (FR-SHP-04, backend doc 8.24). */
@ApiTags("packing")
@Controller("v1/packing")
export class PackingController {
  constructor(@Inject(PackingService) private readonly packing: PackingService) {}

  /** The order behind a scanned order number or tracking number, with what goes in its parcel. */
  @Get("lookup")
  @RequirePermission("shipment:pack")
  @Isolation("self")
  @ZodResponse({ type: PackingViewDto })
  async lookup(@Ctx() ctx: RequestContext, @Query() q: PackingLookupQueryDto) {
    return packingView(await this.packing.lookup(ctx, q.code));
  }

  /**
   * The station's scans: 422 `packing.mismatch` with the lines that differ and the codes not on the order;
   * when everything matches, the order is packed and, with `print`, its label goes to the agent.
   */
  @Post("orders/:id/complete")
  @HttpCode(200)
  @RequirePermission("shipment:pack")
  @Isolation({ fixture: "order" })
  @ZodResponse({ type: PackingResultDto })
  async complete(@Ctx() ctx: RequestContext, @Param() p: OrderIdParamDto, @Body() body: CompletePackingDto) {
    const done = await this.packing.complete(ctx, p.id, body);
    return {
      order: scannedOrderView(done.order),
      documentId: done.print?.documentId ?? null,
      printJob: done.print ? printJobView(done.print.printJob) : null,
      printRefusal: done.printRefusal,
    };
  }
}

/** UI L08 "Serah terima kurir" (FR-SHP-05, backend doc 8.24). */
@ApiTags("handovers")
@Controller("v1/handovers")
export class HandoversController {
  constructor(@Inject(HandoverService) private readonly handovers: HandoverService) {}

  /** "Riwayat manifest": newest first, in the caller's warehouses. */
  @Get()
  @RequirePermission("shipment:handover")
  @Isolation({ fixture: "handover" })
  @ZodResponse({ type: HandoverPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: HandoverQueryDto) {
    const page = await this.handovers.list(
      ctx,
      { status: q.status, warehouseId: q.warehouseId },
      decodeCursor(q.cursor),
      q.limit,
    );
    const last = page.items[page.items.length - 1];
    return {
      items: page.items.map(handoverView),
      next_cursor: page.more && last ? encodeCursor(last.handover.id) : null,
    };
  }

  /** The open manifest of this warehouse and courier, opened now when there is none. */
  @Post()
  @RequirePermission("shipment:handover")
  @Isolation({ fixture: "warehouse" })
  @ZodResponse({ status: 201, type: HandoverDto })
  async open(@Ctx() ctx: RequestContext, @Body() body: OpenHandoverDto) {
    return handoverView(await this.handovers.open(ctx, body));
  }

  /** Couriers of the packed parcels waiting in a warehouse, with how many each. */
  @Get("couriers")
  @RequirePermission("shipment:handover")
  @Isolation("self")
  @ZodResponse({ type: HandoverCouriersDto })
  async couriers(@Ctx() ctx: RequestContext, @Query() q: HandoverCouriersQueryDto) {
    return { items: await this.handovers.couriers(ctx, q.warehouseId) };
  }

  @Get(":id")
  @RequirePermission("shipment:handover")
  @Isolation({ fixture: "handover" })
  @ZodResponse({ type: HandoverDetailDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: HandoverIdParamDto) {
    const found = await this.handovers.get(ctx, p.id);
    return { ...handoverView(found), items: found.items.map(handoverItemView) };
  }

  /** A scanned tracking number (or order number) joins the manifest; 409 with the reason when it may not. */
  @Post(":id/scan")
  @HttpCode(200)
  @RequirePermission("shipment:handover")
  @Isolation({ fixture: "handover" })
  @ZodResponse({ type: HandoverScanResultDto })
  async scan(@Ctx() ctx: RequestContext, @Param() p: HandoverIdParamDto, @Body() body: HandoverScanDto) {
    const done = await this.handovers.scan(ctx, p.id, body.code);
    return { item: handoverItemView(done.item), parcels: done.parcels, duplicate: done.duplicate };
  }

  /** Takes a parcel scanned by mistake out of an open manifest. */
  @Delete(":id/items/:itemId")
  @RequirePermission("shipment:handover")
  @Isolation({ fixture: "handover" })
  @ZodResponse({ type: HandoverDto })
  async removeItem(@Ctx() ctx: RequestContext, @Param() p: HandoverItemParamDto) {
    return handoverView(await this.handovers.removeItem(ctx, p.id, p.itemId));
  }

  /**
   * "Selesaikan serah terima": marketplace parcels are handed over, manual orders shipped, and the manifest
   * is rendered (printed on an agent with `print`). 409 `handover.items_invalid` lists parcels that may no
   * longer go.
   */
  @Post(":id/complete")
  @HttpCode(200)
  @RequirePermission("shipment:handover")
  @Isolation({ fixture: "handover" })
  @ZodResponse({ type: CompletedHandoverDto })
  async complete(@Ctx() ctx: RequestContext, @Param() p: HandoverIdParamDto, @Body() body: CompleteHandoverDto) {
    const done = await this.handovers.complete(ctx, p.id, body);
    return {
      handover: handoverView(done),
      document: documentView(done.document, done.printJob),
      printJob: done.printJob ? printJobView(done.printJob) : null,
    };
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("shipment:handover")
  @Isolation({ fixture: "handover" })
  @ZodResponse({ type: HandoverDto })
  async cancel(@Ctx() ctx: RequestContext, @Param() p: HandoverIdParamDto) {
    return handoverView(await this.handovers.cancel(ctx, p.id));
  }

  /** The manifest of a completed handover again (download, or print on an agent). */
  @Post(":id/manifest")
  @HttpCode(202)
  @RequirePermission("shipment:handover")
  @Isolation({ fixture: "handover" })
  @ZodResponse({ status: 202, type: ManifestDocumentDto })
  async manifest(@Ctx() ctx: RequestContext, @Param() p: HandoverIdParamDto, @Body() body: ManifestRequestDto) {
    const made = await this.handovers.manifest(ctx, p.id, body.print);
    return {
      document: documentView(made.document, made.printJob),
      printJob: made.printJob ? printJobView(made.printJob) : null,
    };
  }
}
