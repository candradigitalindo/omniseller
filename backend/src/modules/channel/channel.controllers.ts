import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import { decodeCursor, page } from "../../common/http/pagination";
import type { AuthedRequest } from "../../common/http/request";
import { SyncLogService } from "../sync/sync-log.service";
import { CONNECTORS, type ConnectorRegistry, MANIFESTS, SUPPORTED_CHANNELS } from "./connector-registry";
import {
  AuthorizationCallbackDto,
  AuthorizationDto,
  authorizationView,
  ChannelListDto,
  ChannelWarehouseDto,
  ChannelWarehouseListDto,
  ChannelWarehouseParamDto,
  CreateManualStoreDto,
  channelWarehouseView,
  DisconnectedStoreDto,
  DisconnectStoreDto,
  MapChannelWarehouseDto,
  StartAuthorizationDto,
  StartedAuthorizationDto,
  StoreDto,
  StoreIdParamDto,
  StoreListDto,
  SyncJobPageDto,
  SyncJobsQueryDto,
  storeView,
  syncJobView,
  UpdateStoreDto,
} from "./dto";
import { StoreAuthorizationService } from "./store-authorization.service";
import { StoresService } from "./stores.service";

@ApiTags("channels")
@Controller("v1/channels")
@RequirePermission("settings:store")
export class ChannelsController {
  constructor(@Inject(CONNECTORS) private readonly connectors: ConnectorRegistry) {}

  /** Marketplaces a store can be connected to, and whether OmniSeller is set up for each. */
  @Get()
  @Isolation("global")
  @ZodResponse({ type: ChannelListDto })
  list() {
    return {
      items: SUPPORTED_CHANNELS.map((id) => ({
        id,
        name: MANIFESTS[id].displayName,
        available: this.connectors.isConfigured(id),
        regions: [...MANIFESTS[id].supportedRegions],
      })),
    };
  }
}

@ApiTags("stores")
@Controller("v1/store-authorizations")
@RequirePermission("settings:store")
export class StoreAuthorizationsController {
  constructor(@Inject(StoreAuthorizationService) private readonly authorizations: StoreAuthorizationService) {}

  /**
   * Starts connecting (or, with storeId, reconnecting) a store. Open `authorizeUrl` in the browser; the
   * marketplace sends the seller back to /integrasi/callback/{channel} on the web app.
   */
  @Post()
  @Isolation({ fixture: "store" })
  @ZodResponse({ status: 201, type: StartedAuthorizationDto })
  async start(@Ctx() ctx: RequestContext, @Body() body: StartAuthorizationDto) {
    const { view, authorizeUrl } = await this.authorizations.start(ctx, body);
    return { ...authorizationView(view), authorizeUrl };
  }

  /**
   * The web app posts the query parameters the marketplace appended to the redirect. Answers 202 while
   * the worker exchanges the code; poll GET /v1/store-authorizations/{id} until it is final.
   */
  @Post("callback")
  @HttpCode(202)
  @Isolation({ fixture: "store_authorization" })
  @ZodResponse({ status: 202, type: AuthorizationDto })
  async callback(@Ctx() ctx: RequestContext, @Body() body: AuthorizationCallbackDto) {
    return authorizationView(await this.authorizations.callback(ctx, body));
  }

  @Get(":id")
  @Isolation({ fixture: "store_authorization" })
  @ZodResponse({ type: AuthorizationDto })
  async get(@Ctx() ctx: RequestContext, @Param() params: StoreIdParamDto) {
    return authorizationView(await this.authorizations.get(ctx, params.id));
  }
}

@ApiTags("stores")
@Controller("v1/stores")
export class StoresController {
  constructor(
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(SyncLogService) private readonly syncLog: SyncLogService,
  ) {}

  /** Connected stores the caller may see (store scope applies). */
  @Get()
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: StoreListDto })
  async list(@Ctx() ctx: RequestContext) {
    return { items: (await this.stores.list(ctx)).map(storeView) };
  }

  /** A sales channel for manual orders (FR-ORD-09): channel `manual`, always live, no marketplace. */
  @Post("manual")
  @RequirePermission("settings:store")
  @Isolation("self")
  @ZodResponse({ status: 201, type: StoreDto })
  async createManual(@Ctx() ctx: RequestContext, @Body() body: CreateManualStoreDto) {
    return storeView(await this.stores.createManual(ctx, body));
  }

  @Get(":id")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: StoreDto })
  async get(@Ctx() ctx: RequestContext, @Param() params: StoreIdParamDto, @Res({ passthrough: true }) res: Response) {
    const view = await this.stores.get(ctx, params.id);
    res.setHeader("ETag", `"${view.store.rowVersion}"`);
    return storeView(view);
  }

  @Patch(":id")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: StoreDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param() params: StoreIdParamDto,
    @Body() body: UpdateStoreDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const view = await this.stores.update(ctx, params.id, body, parseIfMatch(req));
    res.setHeader("ETag", `"${view.store.rowVersion}"`);
    return storeView(view);
  }

  /**
   * FR-INT-07: stops syncing and deletes the store's tokens; its open orders stop holding stock. With
   * `keepData` false its orders, listings, and sync log are deleted for good, in the background.
   */
  @Post(":id/disconnect")
  @HttpCode(200)
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: DisconnectedStoreDto })
  async disconnect(@Ctx() ctx: RequestContext, @Param() params: StoreIdParamDto, @Body() body: DisconnectStoreDto) {
    const { view, revokeUrl } = await this.stores.disconnect(ctx, params.id, body.keepData);
    return { store: storeView(view), revokeUrl };
  }

  /** Pulls the marketplace's warehouse list again (it is also refreshed every 6 hours). */
  @Post(":id/warehouses/sync")
  @HttpCode(202)
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  async syncWarehouses(@Ctx() ctx: RequestContext, @Param() params: StoreIdParamDto): Promise<void> {
    await this.stores.requestWarehouseSync(ctx, params.id);
  }

  @Get(":id/channel-warehouses")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: ChannelWarehouseListDto })
  async channelWarehouses(@Ctx() ctx: RequestContext, @Param() params: StoreIdParamDto) {
    return { items: (await this.stores.channelWarehouses(ctx, params.id)).map(channelWarehouseView) };
  }

  /** Maps a marketplace warehouse to an OmniSeller warehouse (FR-WHS-02), or removes the mapping. */
  @Put(":id/channel-warehouses/:channelWarehouseId")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: ChannelWarehouseDto })
  async mapChannelWarehouse(
    @Ctx() ctx: RequestContext,
    @Param() params: ChannelWarehouseParamDto,
    @Body() body: MapChannelWarehouseDto,
  ) {
    return channelWarehouseView(
      await this.stores.mapChannelWarehouse(ctx, params.id, params.channelWarehouseId, body.warehouseId),
    );
  }

  /** The store's sync log (FR-INT-06), newest first. */
  @Get(":id/sync-jobs")
  @RequirePermission("settings:store")
  @Isolation({ fixture: "store" })
  @ZodResponse({ type: SyncJobPageDto })
  async syncJobs(@Ctx() ctx: RequestContext, @Param() params: StoreIdParamDto, @Query() query: SyncJobsQueryDto) {
    await this.stores.get(ctx, params.id);
    const rows = await this.syncLog.list(ctx, params.id, decodeCursor(query.cursor), query.limit);
    const p = page(rows, query.limit);
    return { items: p.items.map(syncJobView), next_cursor: p.next_cursor };
  }
}
