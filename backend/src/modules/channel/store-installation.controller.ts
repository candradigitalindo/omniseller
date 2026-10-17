import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { ForbiddenError, RateLimitedError } from "../../common/errors/domain-errors";
import { Ctx, Isolation, Public, RequirePermission } from "../../common/http/decorators";
import { type AuthedRequest, clientIp, readCookie } from "../../common/http/request";
import { RATE_RULES, type RateLimiter } from "../../common/security/rate-limiter";
import { ENV } from "../../config/config.module";
import { RATE_LIMITER } from "../../infra/tokens";
import { authorizationInvalid } from "./channel.errors";
import {
  AuthorizationDto,
  authorizationView,
  CapturedStoreInstallationDto,
  CaptureStoreInstallationDto,
  ConfirmStoreInstallationDto,
  SelectInstallationShopsDto,
  StoreInstallationChallengeDto,
} from "./dto";
import { StoreAuthorizationService } from "./store-authorization.service";
import { INSTALLATION_TTL_SECONDS } from "./store-installation.store";

export const INSTALLATION_COOKIE = "os_tiktok_install";

/** A public App Store redirect has no OAuth state: capture first, then require an explicit user decision. */
@ApiTags("stores")
@Controller("v1/store-installations/tiktokshop")
export class StoreInstallationsController {
  constructor(
    @Inject(StoreAuthorizationService) private readonly authorizations: StoreAuthorizationService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ENV) private readonly env: { NODE_ENV: string; PUBLIC_WEB_URL: string },
  ) {}

  private sameOrigin(req: AuthedRequest, required: boolean): void {
    const origin = req.header("origin");
    if ((!origin && required) || (origin && origin !== new URL(this.env.PUBLIC_WEB_URL).origin))
      throw new ForbiddenError("store_authorization.origin_invalid", "Buka pemasangan dari aplikasi OmniSeller.");
    const site = req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none")
      throw new ForbiddenError("store_authorization.origin_invalid", "Buka pemasangan dari aplikasi OmniSeller.");
  }

  private receipt(req: AuthedRequest): string {
    const token = readCookie(req, INSTALLATION_COOKIE);
    if (!token) throw authorizationInvalid();
    return token;
  }

  /** The web server posts a code once and forwards only the opaque HttpOnly receipt to the browser. */
  @Post("capture")
  @Public()
  @ZodResponse({ status: 201, type: CapturedStoreInstallationDto })
  async capture(
    @Body() body: CaptureStoreInstallationDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.sameOrigin(req, true);
    const decision = await this.limiter.take(`store-install:ip:${clientIp(req)}`, RATE_RULES.loginPerIp);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
    const captured = await this.authorizations.captureInstallation(body.code, body.applicationId);
    res.cookie(INSTALLATION_COOKIE, captured.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.env.NODE_ENV !== "local" && this.env.NODE_ENV !== "test",
      path: "/v1/store-installations",
      maxAge: INSTALLATION_TTL_SECONDS * 1000,
    });
    return { expiresAt: captured.expiresAt.toISOString() };
  }

  @Get()
  @RequirePermission("settings:store")
  @Isolation("self")
  @ZodResponse({ type: StoreInstallationChallengeDto })
  async inspect(@Ctx() ctx: RequestContext, @Req() req: AuthedRequest) {
    this.sameOrigin(req, false);
    const challenge = await this.authorizations.inspectInstallation(ctx, this.receipt(req), req.sessionToken ?? "");
    return { ...challenge, expiresAt: challenge.expiresAt.toISOString() };
  }

  @Post("confirm")
  @HttpCode(202)
  @RequirePermission("settings:store")
  @Isolation("self")
  @ZodResponse({ status: 202, type: AuthorizationDto })
  async confirm(@Ctx() ctx: RequestContext, @Body() body: ConfirmStoreInstallationDto, @Req() req: AuthedRequest) {
    this.sameOrigin(req, true);
    return authorizationView(
      await this.authorizations.confirmInstallation(ctx, {
        receipt: this.receipt(req),
        session: req.sessionToken ?? "",
        confirmationToken: body.confirmationToken,
      }),
    );
  }

  /** Final binding requires a separate choice of the shop identities returned by the marketplace. */
  @Post("select-shops")
  @HttpCode(202)
  @RequirePermission("settings:store")
  @Isolation("self")
  @ZodResponse({ status: 202, type: AuthorizationDto })
  async selectShops(@Ctx() ctx: RequestContext, @Body() body: SelectInstallationShopsDto, @Req() req: AuthedRequest) {
    this.sameOrigin(req, true);
    return authorizationView(
      await this.authorizations.selectInstallationShops(ctx, {
        ...body,
        receipt: this.receipt(req),
        session: req.sessionToken ?? "",
      }),
    );
  }
}
