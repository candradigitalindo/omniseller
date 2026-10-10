import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { AllowWhileClosing, Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import type { AuthedRequest } from "../../common/http/request";
import { AccountClosureService } from "./closure.service";
import { AccountClosureDto, CloseAccountDto, closureView } from "./dto";

@ApiTags("account-closure")
@Controller("v1/account-closure")
export class AccountClosureController {
  constructor(@Inject(AccountClosureService) private readonly closure: AccountClosureService) {}

  /** L47 "Tutup akun bisnis" and L54 "Akun ditutup": whether the account is closing, and until when. */
  @Get()
  @RequirePermission("settings:billing")
  @Isolation("self")
  @ZodResponse({ type: AccountClosureDto })
  async get(@Ctx() ctx: RequestContext) {
    return closureView(await this.closure.get(ctx));
  }

  /**
   * Closes the account (backend doc 8.36): stores disconnected, plan to Starter, members signed out, data
   * deleted after `purgeAfterDays`. 409 `account.closing` when already closing.
   */
  @Post()
  @HttpCode(200)
  @RequirePermission("settings:billing")
  @Isolation("self")
  @ZodResponse({ type: AccountClosureDto })
  async close(@Ctx() ctx: RequestContext, @Body() body: CloseAccountDto, @Req() req: AuthedRequest) {
    return closureView(await this.closure.close(ctx, body, req.sessionToken));
  }

  /** Reopens a closing account before its data is deleted. 409 `account.not_closing` otherwise. */
  @Delete()
  @RequirePermission("settings:billing")
  @Isolation("self")
  @AllowWhileClosing()
  @ZodResponse({ type: AccountClosureDto })
  async reopen(@Ctx() ctx: RequestContext) {
    return closureView(await this.closure.reopen(ctx));
  }
}
