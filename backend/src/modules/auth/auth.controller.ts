import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ZodResponse } from "nestjs-zod";
import { RateLimitedError } from "../../common/errors/domain-errors";
import { Isolation, Public } from "../../common/http/decorators";
import { type AuthedRequest, clientIp } from "../../common/http/request";
import { RATE_RULES, type RateLimiter } from "../../common/security/rate-limiter";
import { ENV } from "../../config/config.module";
import { RATE_LIMITER } from "../../infra/tokens";
import {
  AcceptInvitationDto,
  InvitationPreviewDto,
  InvitationTokenDto,
  LoginDto,
  MeDto,
  meView,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  SignupDto,
} from "../identity/dto";
import { InvitationsService } from "../identity/invitations.service";
import { TenantsService } from "../identity/tenants.service";
import { UsersService } from "../identity/users.service";
import { authRequired } from "./auth.errors";
import { AuthService } from "./auth.service";
import { clearSessionCookie, setSessionCookie } from "./session-cookie";

@ApiTags("auth")
@Controller("v1/auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ENV) private readonly env: { NODE_ENV: string },
  ) {}

  /** Creates a business with its Owner and signs the Owner in (PRD 7.1 step 1). */
  @Post("signup")
  @Public()
  @ZodResponse({ status: 201, type: MeDto })
  async signup(@Body() body: SignupDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const ip = clientIp(req);
    const d = await this.limiter.take(`signup:ip:${ip}`, RATE_RULES.signupPerIp);
    if (!d.allowed) throw new RateLimitedError(d.retryAfterSeconds);
    const { tenantId, userId } = await this.tenants.signup(body);
    return this.signIn(tenantId, userId, req, res);
  }

  @Post("login")
  @Public()
  @ZodResponse({ status: 200, type: MeDto })
  async login(@Body() body: LoginDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const { token, tenantId, userId } = await this.auth.login({
      email: body.email,
      password: body.password,
      tenant: body.tenant,
      ip: clientIp(req),
      userAgent: req.header("user-agent"),
    });
    setSessionCookie(res, token, this.env.NODE_ENV);
    return this.me(tenantId, userId);
  }

  @Post("logout")
  @Isolation("self")
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (req.sessionToken) await this.auth.logout(req.sessionToken);
    clearSessionCookie(res, this.env.NODE_ENV);
  }

  /** Always 202: whether the email exists is never revealed. */
  @Post("password-reset")
  @Public()
  @HttpCode(202)
  async requestPasswordReset(@Body() body: PasswordResetRequestDto, @Req() req: AuthedRequest): Promise<void> {
    await this.auth.requestPasswordReset(body.email, clientIp(req));
  }

  @Post("password-reset/confirm")
  @Public()
  @HttpCode(204)
  async confirmPasswordReset(@Body() body: PasswordResetConfirmDto): Promise<void> {
    await this.auth.confirmPasswordReset(body.token, body.password);
  }

  /** What the invitation page shows before the new member sets a password. POST keeps the token out of URLs and logs. */
  @Post("invitations/inspect")
  @Public()
  @ZodResponse({ status: 200, type: InvitationPreviewDto })
  async inspectInvitation(@Body() body: InvitationTokenDto) {
    const p = await this.invitations.inspect(body.token);
    return { ...p, expiresAt: p.expiresAt.toISOString() };
  }

  @Post("invitations/accept")
  @Public()
  @ZodResponse({ status: 201, type: MeDto })
  async acceptInvitation(
    @Body() body: AcceptInvitationDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { tenantId, userId } = await this.invitations.accept(body.token, {
      name: body.name,
      password: body.password,
    });
    return this.signIn(tenantId, userId, req, res);
  }

  private async signIn(tenantId: string, userId: string, req: AuthedRequest, res: Response) {
    const token = await this.auth.startSession(tenantId, userId, clientIp(req), req.header("user-agent"));
    setSessionCookie(res, token, this.env.NODE_ENV);
    return this.me(tenantId, userId);
  }

  private async me(tenantId: string, userId: string) {
    const principal = await this.users.loadPrincipal(tenantId, userId);
    if (!principal) throw authRequired();
    return meView(principal);
  }
}
