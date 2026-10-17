import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import { decodeCursor, page } from "../../common/http/pagination";
import type { AuthedRequest } from "../../common/http/request";
import {
  AffiliateAccountCallbackDto,
  AffiliateAccountDto,
  AffiliateAccountIdDto,
  AffiliateAccountPageDto,
  AffiliateAccountQueryDto,
  AffiliateAuthorizationDto,
  accountView,
  authorizationView,
  RenameAffiliateAccountDto,
  StartAffiliateAuthorizationDto,
  StartedAffiliateAuthorizationDto,
} from "./accounts.dto";
import { AffiliateAccountsService } from "./accounts.service";
@ApiTags("affiliate-accounts")
@Controller("v1/affiliate/accounts")
export class AffiliateAccountsController {
  constructor(@Inject(AffiliateAccountsService) private readonly accounts: AffiliateAccountsService) {}
  @Get()
  @ApiOperation({ summary: "Akun creator dan partner bisnis, terpisah dari cakupan toko seller" })
  @RequirePermission("affiliate:account_read")
  @Isolation({ fixture: "affiliate_account" })
  @ZodResponse({ type: AffiliateAccountPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: AffiliateAccountQueryDto) {
    const result = page(await this.accounts.list(ctx, decodeCursor(q.cursor), q.q, q.limit), q.limit);
    return { ...result, items: result.items.map(accountView) };
  }
  @Get(":id")
  @ApiOperation({ summary: "Profil dan scope akun affiliate tanpa kredensial" })
  @RequirePermission("affiliate:account_read")
  @Isolation({ fixture: "affiliate_account" })
  @ZodResponse({ type: AffiliateAccountDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: AffiliateAccountIdDto) {
    return accountView(await this.accounts.get(ctx, p.id));
  }
  @Patch(":id")
  @ApiHeader({ name: "If-Match", required: false, schema: { type: "string" } })
  @ApiOperation({ summary: "Ubah nama akun di OmniSeller" })
  @RequirePermission("affiliate:account_write")
  @Isolation({ fixture: "affiliate_account" })
  @ZodResponse({ type: AffiliateAccountDto })
  async rename(
    @Ctx() ctx: RequestContext,
    @Param() p: AffiliateAccountIdDto,
    @Body() b: RenameAffiliateAccountDto,
    @Req() req: AuthedRequest,
  ) {
    return accountView(await this.accounts.rename(ctx, p.id, b.name, parseIfMatch(req)));
  }
  @Post(":id/disconnect")
  @HttpCode(204)
  @ApiOperation({ summary: "Putuskan akun dari OmniSeller dan hapus token tersimpan" })
  @RequirePermission("affiliate:account_write")
  @Isolation({ fixture: "affiliate_account" })
  async disconnect(@Ctx() ctx: RequestContext, @Param() p: AffiliateAccountIdDto) {
    await this.accounts.disconnect(ctx, p.id);
  }
  @Post(":id/refresh")
  @HttpCode(202)
  @ApiOperation({ summary: "Perbarui token/profil akun melalui worker" })
  @ApiHeader({ name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 100 } })
  @RequirePermission("affiliate:account_write")
  @Isolation({ fixture: "affiliate_account" })
  async refresh(@Ctx() ctx: RequestContext, @Param() p: AffiliateAccountIdDto, @Req() req: AuthedRequest) {
    await this.accounts.refresh(ctx, p.id, req.get("Idempotency-Key"));
  }
}
@ApiTags("affiliate-accounts")
@Controller("v1/affiliate/authorizations")
export class AffiliateAuthorizationsController {
  constructor(@Inject(AffiliateAccountsService) private readonly accounts: AffiliateAccountsService) {}
  @Post()
  @ApiOperation({ summary: "Buat tautan otorisasi creator/partner dengan state sekali pakai" })
  @RequirePermission("affiliate:account_write")
  @Isolation("self")
  @ZodResponse({ type: StartedAffiliateAuthorizationDto })
  async start(@Ctx() ctx: RequestContext, @Body() b: StartAffiliateAuthorizationDto) {
    const result = await this.accounts.start(ctx, b);
    return { ...authorizationView(result.row), authorizeUrl: result.authorizeUrl };
  }
  @Post("callback")
  @ApiOperation({ summary: "Validasi callback akun affiliate dan antrekan penukaran kode" })
  @RequirePermission("affiliate:account_write")
  @Isolation("self")
  @ZodResponse({ type: AffiliateAuthorizationDto })
  async callback(@Ctx() ctx: RequestContext, @Body() b: AffiliateAccountCallbackDto) {
    return authorizationView(await this.accounts.callback(ctx, b));
  }
  @Get(":id")
  @ApiOperation({ summary: "Status penukaran kode dan verifikasi akun affiliate" })
  @RequirePermission("affiliate:account_write")
  @Isolation({ fixture: "affiliate_authorization" })
  @ZodResponse({ type: AffiliateAuthorizationDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: AffiliateAccountIdDto) {
    return authorizationView(await this.accounts.getAuthorization(ctx, p.id));
  }
}
