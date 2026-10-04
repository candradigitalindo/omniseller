import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { ApiHeader, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import type { AuthedRequest } from "../../common/http/request";
import { idempotencyKey } from "../../common/idempotency";
import { channelDisplayName, StoresService } from "../channel/stores.service";
import { CategoriesService, rulesOf } from "./categories.service";
import {
  CategoryDetailDto,
  CategoryPageDto,
  CategoryQueryDto,
  CategoryRefreshDto,
  CopyDto,
  CopyIdParamDto,
  CopyListDto,
  CopyPageDto,
  CopyQueryDto,
  CreateCopyDto,
  categoryView,
  copyView,
  DraftAttributeDto,
  DraftAttributeResultDto,
  DraftCategoryDto,
  DraftCategoryResultDto,
  DraftDto,
  DraftIdParamDto,
  DraftPageDto,
  DraftQueryDto,
  draftSummaryView,
  draftView,
  PublishDraftsDto,
  PublishResultDto,
  rulesView,
  StoreCategoryParamDto,
  StoreIdParamDto,
  UpdateDraftDto,
} from "./dto";
import { type CopyView, ListingCopyService } from "./listing-copy.service";

/** Category picker of the copy drafts (FR-PRD-13, backend doc 8.25): a store's marketplace categories. */
@ApiTags("listing-copies")
@Controller("v1/stores")
export class StoreCategoriesController {
  constructor(@Inject(CategoriesService) private readonly categories: CategoriesService) {}

  /** Top-level categories, the children of `parentId`, or a search over full paths (`q`). */
  @Get(":id/categories")
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: CategoryPageDto })
  async list(@Ctx() ctx: RequestContext, @Param() p: StoreIdParamDto, @Query() q: CategoryQueryDto) {
    const page = await this.categories.list(
      ctx,
      p.id,
      { parentId: q.parentId, q: q.q, leafOnly: q.leafOnly === "true" },
      q.limit,
    );
    return {
      items: page.items.map(categoryView),
      total: page.total,
      refreshedAt: page.refreshedAt?.toISOString() ?? null,
    };
  }

  /** Reads the store's categories again from the marketplace (202; at most once per 10 minutes). */
  @Post(":id/categories/refresh")
  @HttpCode(202)
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "store" })
  @ZodResponse({ status: 202, type: CategoryRefreshDto })
  async refresh(@Ctx() ctx: RequestContext, @Param() p: StoreIdParamDto) {
    const r = await this.categories.requestRefresh(ctx, p.id);
    return { requested: r.requested, refreshedAt: r.refreshedAt?.toISOString() ?? null };
  }

  /** A category with its attributes and limits; rules not read yet are queued (`rulesPending`). */
  @Get(":id/categories/:categoryId")
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: CategoryDetailDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: StoreCategoryParamDto) {
    const { category, rulesPending } = await this.categories.get(ctx, p.id, p.categoryId);
    const rules = rulesOf(category);
    return {
      ...categoryView(category),
      rules: rules ? rulesView(rules) : null,
      rulesPending,
      rulesReadAt: category.rulesReadAt?.toISOString() ?? null,
    };
  }
}

/** UI L13 "Tambah produk > Salin dari toko" (FR-PRD-13): copies of listings, or of a whole store, into drafts. */
@ApiTags("listing-copies")
@Controller("v1/listing-copies")
export class ListingCopiesController {
  constructor(
    @Inject(ListingCopyService) private readonly copies: ListingCopyService,
    @Inject(StoresService) private readonly stores: StoresService,
  ) {}

  private async views(ctx: RequestContext, items: CopyView[]) {
    const known = new Map((await this.stores.list(ctx)).map((v) => [v.store.id, v.store]));
    const ref = (id: string) => {
      const s = known.get(id);
      return {
        id,
        name: s?.name ?? "",
        channel: s?.channel ?? "",
        channelName: s ? channelDisplayName(s.channel) : "",
      };
    };
    return items.map((v) => copyView(v, ref));
  }

  /**
   * One copy per target store (202), prepared in the background: without `listingIds` every item of the
   * source store is copied ("Salin toko"). With Idempotency-Key a repeated request returns the same copies.
   */
  @Post()
  @HttpCode(202)
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "store" })
  @ApiHeader({ name: "Idempotency-Key", required: false, description: "8-100 karakter; mencegah salinan ganda" })
  @ZodResponse({ status: 202, type: CopyListDto })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() body: CreateCopyDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req.header("idempotency-key"));
    const done = await this.copies.create(ctx, body, key);
    if (!done.created) res.setHeader("Idempotent-Replayed", "true");
    return { items: await this.views(ctx, done.copies) };
  }

  @Get()
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "listing_copy" })
  @ZodResponse({ type: CopyPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: CopyQueryDto) {
    const page = await this.copies.list(
      ctx,
      { targetStoreId: q.targetStoreId, sourceStoreId: q.sourceStoreId, status: q.status },
      decodeCursor(q.cursor),
      q.limit,
    );
    const last = page.items[page.items.length - 1];
    return {
      items: await this.views(ctx, page.items),
      next_cursor: page.more && last ? encodeCursor(last.copy.id) : null,
    };
  }

  /** Progress: items drafted, skipped, and failed (with the reasons), and drafts per status. */
  @Get(":id")
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "listing_copy" })
  @ZodResponse({ type: CopyDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: CopyIdParamDto) {
    return (await this.views(ctx, [await this.copies.get(ctx, p.id)]))[0]!;
  }

  /** Stops preparing (a whole store takes a while); the drafts made so far stay. */
  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "listing_copy" })
  @ZodResponse({ type: CopyDto })
  async cancel(@Ctx() ctx: RequestContext, @Param() p: CopyIdParamDto) {
    return (await this.views(ctx, [await this.copies.cancel(ctx, p.id)]))[0]!;
  }
}

/** Drafts of a copy (L13 "Salin dari toko"): review, edit, and publish copied listings (FR-PRD-13). */
@ApiTags("listing-copies")
@Controller("v1/listing-drafts")
export class ListingDraftsController {
  constructor(@Inject(ListingCopyService) private readonly copies: ListingCopyService) {}

  @Get()
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "listing_draft" })
  @ZodResponse({ type: DraftPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: DraftQueryDto) {
    const page = await this.copies.listDrafts(
      ctx,
      {
        copyId: q.copyId,
        targetStoreId: q.targetStoreId,
        status: q.status,
        q: q.q,
        blocking: q.blocking === undefined ? undefined : q.blocking === "true",
      },
      decodeCursor(q.cursor),
      q.limit,
    );
    const last = page.items[page.items.length - 1];
    return {
      items: page.items.map(draftSummaryView),
      next_cursor: page.more && last ? encodeCursor(last.id) : null,
    };
  }

  @Get(":id")
  @RequirePermission("catalog:read")
  @Isolation({ fixture: "listing_draft" })
  @ZodResponse({ type: DraftDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: DraftIdParamDto, @Res({ passthrough: true }) res: Response) {
    const d = await this.copies.getDraft(ctx, p.id);
    res.setHeader("ETag", `"${d.rowVersion}"`);
    return draftView(d);
  }

  /** Edits a draft that is not being worked on; its problems are checked again. If-Match: row_version. */
  @Patch(":id")
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "listing_draft" })
  @ZodResponse({ type: DraftDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param() p: DraftIdParamDto,
    @Body() body: UpdateDraftDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const d = await this.copies.updateDraft(ctx, p.id, body, parseIfMatch(req));
    res.setHeader("ETag", `"${d.rowVersion}"`);
    return draftView(d);
  }

  /** Removes a draft; a published draft only leaves the list (the product stays on the marketplace). */
  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "listing_draft" })
  async remove(@Ctx() ctx: RequestContext, @Param() p: DraftIdParamDto): Promise<void> {
    await this.copies.deleteDraft(ctx, p.id);
  }

  /** Moves drafts of one target store to another category (202): its attributes are prepared again. */
  @Post("category")
  @HttpCode(202)
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "listing_draft" })
  @ZodResponse({ status: 202, type: DraftCategoryResultDto })
  async setCategory(@Ctx() ctx: RequestContext, @Body() body: DraftCategoryDto) {
    return this.copies.setCategory(ctx, body.draftIds, body.categoryId);
  }

  /** Sets one attribute on many drafts (for example "Barang Impor" on Tokopedia & Shop). */
  @Post("attributes")
  @HttpCode(200)
  @RequirePermission("catalog:write")
  @Isolation({ fixture: "listing_draft" })
  @ZodResponse({ type: DraftAttributeResultDto })
  async setAttribute(@Ctx() ctx: RequestContext, @Body() body: DraftAttributeDto) {
    return this.copies.setAttribute(ctx, body);
  }

  /** Creates drafts without blocking problems in their target stores (202); the others come back refused. */
  @Post("publish")
  @HttpCode(202)
  @RequirePermission("catalog:publish")
  @Isolation({ fixture: "listing_draft" })
  @ZodResponse({ status: 202, type: PublishResultDto })
  async publish(@Ctx() ctx: RequestContext, @Body() body: PublishDraftsDto) {
    return this.copies.publish(ctx, body.draftIds);
  }
}
