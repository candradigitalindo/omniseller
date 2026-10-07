import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation } from "../../common/http/decorators";
import type { AuthedRequest } from "../../common/http/request";
import { RevokedDto } from "../identity/dto";
import {
  BackupCodesDto,
  DisableTwoFactorDto,
  EnableTwoFactorDto,
  PasswordConfirmDto,
  SessionIdParamDto,
  SessionListDto,
  TwoFactorSetupDto,
  TwoFactorStatusDto,
} from "./dto";
import { TwoFactorService } from "./two-factor.service";
import { UserSessionsService } from "./user-sessions.service";

/** Verification in two steps for the signed-in user (UI L41b, backend doc 8.30). */
@ApiTags("me")
@Controller("v1/me/two-factor")
export class TwoFactorController {
  constructor(@Inject(TwoFactorService) private readonly twoFactor: TwoFactorService) {}

  @Get()
  @Isolation("self")
  @ZodResponse({ type: TwoFactorStatusDto })
  async status(@Ctx() ctx: RequestContext) {
    const s = await this.twoFactor.status(ctx);
    return { ...s, enabledAt: s.enabledAt?.toISOString() ?? null };
  }

  /** After the password: a new secret as a QR code and as text. */
  @Post("setup")
  @Isolation("self")
  @ZodResponse({ status: 200, type: TwoFactorSetupDto })
  async setup(@Ctx() ctx: RequestContext, @Body() body: PasswordConfirmDto) {
    return this.twoFactor.setup(ctx, body.password);
  }

  /** A code from the app turns it on; the backup codes come back once. Other devices are signed out. */
  @Post("enable")
  @Isolation("self")
  @ZodResponse({ status: 200, type: BackupCodesDto })
  async enable(@Ctx() ctx: RequestContext, @Body() body: EnableTwoFactorDto, @Req() req: AuthedRequest) {
    return this.twoFactor.enable(ctx, body.code, req.sessionToken);
  }

  @Post("backup-codes")
  @Isolation("self")
  @ZodResponse({ status: 200, type: BackupCodesDto })
  async backupCodes(@Ctx() ctx: RequestContext, @Body() body: PasswordConfirmDto) {
    return this.twoFactor.regenerateBackupCodes(ctx, body.password);
  }

  @Post("disable")
  @Isolation("self")
  @HttpCode(204)
  async disable(@Ctx() ctx: RequestContext, @Body() body: DisableTwoFactorDto): Promise<void> {
    await this.twoFactor.disable(ctx, body.password, { code: body.code, backupCode: body.backupCode });
  }
}

/** "Perangkat yang masuk": the signed-in user's own sessions (PRD FR-USR-06, backend doc 8.30). */
@ApiTags("me")
@Controller("v1/me/sessions")
export class SessionsController {
  constructor(@Inject(UserSessionsService) private readonly sessions: UserSessionsService) {}

  @Get()
  @Isolation("self")
  @ZodResponse({ type: SessionListDto })
  async list(@Ctx() ctx: RequestContext, @Req() req: AuthedRequest) {
    const items = await this.sessions.list(ctx, req.sessionToken);
    return {
      items: items.map((s) => ({ ...s, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString() })),
      next_cursor: null,
    };
  }

  /** Signs every other device out; this one stays. */
  @Post("revoke-others")
  @Isolation("self")
  @ZodResponse({ status: 200, type: RevokedDto })
  async revokeOthers(@Ctx() ctx: RequestContext, @Req() req: AuthedRequest) {
    return { revoked: await this.sessions.revokeOthers(ctx, req.sessionToken) };
  }

  @Delete(":id")
  @Isolation("self")
  @HttpCode(204)
  async revoke(@Ctx() ctx: RequestContext, @Param() p: SessionIdParamDto, @Req() req: AuthedRequest): Promise<void> {
    await this.sessions.revoke(ctx, p.id, req.sessionToken);
  }
}
