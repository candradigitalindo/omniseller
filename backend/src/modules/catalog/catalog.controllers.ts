import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { seesCost } from "../../common/cost-visibility";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import type { AuthedRequest } from "../../common/http/request";
import {
  AutoMapDto,
  AutoMapResultDto,
  CreateFromListingsDto,
  CreateFromListingsResultDto,
  CreateProductDto,
  CreateVariantDto,
  GenerateBarcodesDto,
  GeneratedBarcodesDto,
  HistoryQueryDto,
  historyEntryView,
  ImportProductsDto,
  ImportSummaryDto,
  ListingDto,
  ListingIdParamDto,
  ListingPageDto,
  ListingQueryDto,
  ListingStatusAcceptedDto,
  ListingStatusDto,
  ListingSyncDto,
  listingView,
  MapListingDto,
  ProductDto,
  ProductHistoryPageDto,
  ProductIdParamDto,
  ProductPageDto,
  ProductQueryDto,
  productView,
  ScanLookupQueryDto,
  ScanMatchDto,
  scanMatchView,
  UnmappedPageDto,
  UnmappedQueryDto,
  UpdateProductDto,
  UpdateVariantDto,
  unmappedView,
  VariantParamDto,
} from "./dto";
import { ListingsService } from "./listings.service";
import { ProductTransferService } from "./product-transfer.service";
import { ProductsService } from "./products.service";

function nextCursor<T extends { id: string }>(items: T[], more: boolean): string | null {
  const last = items[items.length - 1];
  return more && last ? encodeCursor(last.id) : null;
}

@ApiTags("products")
@Controller("v1/products")
export class ProductsController {
  constructor(
    @Inject(ProductsService) private readonly products: ProductsService,
    @Inject(ProductTransferService) private readonly transfer: ProductTransferService,
  ) {}

  @Get()
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "product" })
  @ZodResponse({ type: ProductPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: ProductQueryDto) {
    const page = await this.products.list(ctx, { q: q.q, status: q.status }, decodeCursor(q.cursor), q.limit);
    const showCost = seesCost(ctx);
    const items = page.items.map((v) => productView(v, showCost));
    return { items, next_cursor: nextCursor(items, page.more) };
  }

  /** CSV of every product and variant in the import template's columns (FR-PRD-04). */
  @Get("export")
  @RequirePermission("catalog:read")
  @Isolation("self")
  @ApiProduces("text/csv")
  @ApiOkResponse({ schema: { type: "string" }, description: "CSV, pemisah ;" })
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="produk-omniseller.csv"')
  async exportCsv(@Ctx() ctx: RequestContext): Promise<string> {
    return this.transfer.exportCsv(ctx);
  }

  /** All-or-nothing import from CSV; errors per row and column. `dryRun` previews without saving. */
  @Post("import")
  @HttpCode(200)
  @RequirePermission("catalog:write")
  @Isolation("self")
  @ZodResponse({ type: ImportSummaryDto })
  async importCsv(@Ctx() ctx: RequestContext, @Body() body: ImportProductsDto) {
    return this.transfer.importCsv(ctx, body.content, body.dryRun);
  }

  @Post()
  @RequirePermission("catalog:write")
  @Isolation("self")
  @ZodResponse({ status: 201, type: ProductDto })
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateProductDto) {
    return productView(await this.products.create(ctx, body), seesCost(ctx));
  }

  /** FR-PRD-12: an internal EAN-13 (prefix 20) for each variant without a barcode; others keep theirs. */
  @Post("barcodes")
  @HttpCode(200)
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "variant" })
  @ZodResponse({ type: GeneratedBarcodesDto })
  async generateBarcodes(@Ctx() ctx: RequestContext, @Body() body: GenerateBarcodesDto) {
    const done = await this.products.generateBarcodes(ctx, body.variantIds);
    return {
      items: done.map((d) => ({
        variantId: d.variant.id,
        sku: d.variant.sku,
        barcode: d.variant.barcode!,
        generated: d.generated,
      })),
    };
  }

  /** FR-PRD-12: the variant behind a scanned code, by barcode or else SKU. */
  @Get("lookup")
  @RequirePermission("catalog:read")
  @Isolation("self")
  @ZodResponse({ type: ScanMatchDto })
  async lookup(@Ctx() ctx: RequestContext, @Query() q: ScanLookupQueryDto) {
    return scanMatchView(await this.products.lookup(ctx, q.code));
  }

  @Get(":id")
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "product" })
  @ZodResponse({ type: ProductDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: ProductIdParamDto, @Res({ passthrough: true }) res: Response) {
    const view = await this.products.get(ctx, p.id);
    res.setHeader("ETag", `"${view.product.rowVersion}"`);
    return productView(view, seesCost(ctx));
  }

  /** FR-PRD-11: who changed the product or its variants, what, and when; newest first. */
  @Get(":id/history")
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "product" })
  @ZodResponse({ type: ProductHistoryPageDto })
  async history(@Ctx() ctx: RequestContext, @Param() p: ProductIdParamDto, @Query() q: HistoryQueryDto) {
    const page = await this.products.history(ctx, p.id, decodeCursor(q.cursor), q.limit);
    return { items: page.items.map(historyEntryView), next_cursor: page.next ? encodeCursor(page.next) : null };
  }

  @Patch(":id")
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "product" })
  @ZodResponse({ type: ProductDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param() p: ProductIdParamDto,
    @Body() body: UpdateProductDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const view = await this.products.update(ctx, p.id, body, parseIfMatch(req));
    res.setHeader("ETag", `"${view.product.rowVersion}"`);
    return productView(view, seesCost(ctx));
  }

  /** Refused while listings point at its variants; archive the product instead. */
  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "product" })
  async remove(@Ctx() ctx: RequestContext, @Param() p: ProductIdParamDto): Promise<void> {
    await this.products.remove(ctx, p.id);
  }

  @Post(":id/variants")
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "product" })
  @ZodResponse({ status: 201, type: ProductDto })
  async addVariant(@Ctx() ctx: RequestContext, @Param() p: ProductIdParamDto, @Body() body: CreateVariantDto) {
    return productView(await this.products.addVariant(ctx, p.id, body), seesCost(ctx));
  }

  @Patch(":id/variants/:variantId")
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "product" })
  @ZodResponse({ type: ProductDto })
  async updateVariant(@Ctx() ctx: RequestContext, @Param() p: VariantParamDto, @Body() body: UpdateVariantDto) {
    return productView(await this.products.updateVariant(ctx, p.id, p.variantId, body), seesCost(ctx));
  }
}

@ApiTags("listings")
@Controller("v1/listings")
export class ListingsController {
  constructor(@Inject(ListingsService) private readonly listings: ListingsService) {}

  @Get()
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "listing" })
  @ZodResponse({ type: ListingPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: ListingQueryDto) {
    const page = await this.listings.list(
      ctx,
      {
        storeId: q.storeId,
        status: q.status,
        mapped: q.mapped === undefined ? undefined : q.mapped === "true",
        variantId: q.variantId,
        q: q.q,
      },
      decodeCursor(q.cursor),
      q.limit,
    );
    const items = page.items.map(listingView);
    return { items, next_cursor: nextCursor(items, page.more) };
  }

  /** FR-PRD-03: listings without a master variant, with SKU and name suggestions. */
  @Get("unmapped")
  @RequirePermission("catalog:map")
  @Isolation({ fixture: "listing" })
  @ZodResponse({ type: UnmappedPageDto })
  async unmapped(@Ctx() ctx: RequestContext, @Query() q: UnmappedQueryDto) {
    const page = await this.listings.unmappedWithSuggestions(
      ctx,
      { storeId: q.storeId, q: q.q },
      decodeCursor(q.cursor),
      q.limit,
    );
    const items = page.items.map(unmappedView);
    return { items, next_cursor: nextCursor(items, page.more) };
  }

  @Post("auto-map")
  @HttpCode(200)
  @RequirePermission("catalog:map")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: AutoMapResultDto })
  async autoMap(@Ctx() ctx: RequestContext, @Body() body: AutoMapDto) {
    return { mapped: await this.listings.autoMap(ctx, body.storeId) };
  }

  /** One master product per marketplace item, one variant per listing; same-SKU variants are reused. */
  @Post("create-products")
  @HttpCode(200)
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "listing" })
  @ZodResponse({ type: CreateFromListingsResultDto })
  async createProducts(@Ctx() ctx: RequestContext, @Body() body: CreateFromListingsDto) {
    return this.listings.createProductsFromListings(ctx, body.listingIds);
  }

  /** FR-PRD-10: activate or deactivate on the marketplace, through the worker (202). */
  @Post("status")
  @HttpCode(202)
  @RequirePermission("catalog:publish")
  @Isolation({ fixture: "listing" })
  @ZodResponse({ status: 202, type: ListingStatusAcceptedDto })
  async setStatus(@Ctx() ctx: RequestContext, @Body() body: ListingStatusDto) {
    return this.listings.requestStatus(ctx, body.listingIds, body.active);
  }

  /** Pull listings of a store again (incremental, or everything with `full`). */
  @Post("sync")
  @HttpCode(202)
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "store" })
  async sync(@Ctx() ctx: RequestContext, @Body() body: ListingSyncDto): Promise<void> {
    await this.listings.requestPull(ctx, body.storeId, body.full);
  }

  @Get(":id")
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "listing" })
  @ZodResponse({ type: ListingDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: ListingIdParamDto) {
    return listingView(await this.listings.get(ctx, p.id));
  }

  @Put(":id/mapping")
  @RequirePermission("catalog:map")
  @Isolation({ fixture: "listing" })
  @ZodResponse({ type: ListingDto })
  async map(@Ctx() ctx: RequestContext, @Param() p: ListingIdParamDto, @Body() body: MapListingDto) {
    return listingView(await this.listings.map(ctx, p.id, body.variantId));
  }
}
