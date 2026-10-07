import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import type { AuthedRequest } from "../../common/http/request";
import {
  ChangePasswordDto,
  CreateInvitationDto,
  IdParamDto,
  InvitationDto,
  InvitationPageDto,
  invitationView,
  MeDto,
  meView,
  PageQueryDto,
  PermissionListDto,
  RevokedDto,
  RoleListDto,
  SetRolesDto,
  SetScopesDto,
  UpdateUserDto,
  UserDto,
  UserPageDto,
  userView,
} from "./dto";
import { InvitationsService } from "./invitations.service";
import { RolesService } from "./roles.service";
import { UsersService } from "./users.service";

@ApiTags("me")
@Controller("v1/me")
export class MeController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @Isolation("self")
  @ZodResponse({ type: MeDto })
  async me(@Ctx() ctx: RequestContext) {
    const principal = await this.users.loadPrincipal(ctx.tenantId, ctx.actor.id);
    return meView(principal!);
  }

  /** Changes the caller's password and signs out every other session. */
  @Post("password")
  @Isolation("self")
  @HttpCode(204)
  async changePassword(@Ctx() ctx: RequestContext, @Body() body: ChangePasswordDto, @Req() req: AuthedRequest) {
    await this.users.changeOwnPassword(ctx, body.currentPassword, body.newPassword, req.sessionToken);
  }
}

@ApiTags("users")
@Controller("v1/users")
@RequirePermission("settings:user")
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @Isolation({ fixture: "user" })
  @ZodResponse({ type: UserPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: PageQueryDto) {
    const p = await this.users.list(ctx, q.cursor, q.limit);
    return { items: p.items.map(userView), next_cursor: p.next_cursor };
  }

  @Get(":id")
  @Isolation({ fixture: "user" })
  @ZodResponse({ type: UserDto })
  async get(@Ctx() ctx: RequestContext, @Param() p: IdParamDto, @Req() req: AuthedRequest) {
    const u = await this.users.get(ctx, p.id);
    req.res?.setHeader("ETag", `"${u.rowVersion}"`);
    return userView(u);
  }

  @Patch(":id")
  @Isolation({ fixture: "user" })
  @ZodResponse({ type: UserDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param() p: IdParamDto,
    @Body() body: UpdateUserDto,
    @Req() req: AuthedRequest,
  ) {
    return userView(await this.users.update(ctx, p.id, body, parseIfMatch(req)));
  }

  @Put(":id/roles")
  @Isolation({ fixture: "user" })
  @ZodResponse({ type: UserDto })
  async setRoles(@Ctx() ctx: RequestContext, @Param() p: IdParamDto, @Body() body: SetRolesDto) {
    return userView(await this.users.setRoles(ctx, p.id, body.roleIds));
  }

  @Put(":id/scopes")
  @Isolation({ fixture: "user" })
  @ZodResponse({ type: UserDto })
  async setScopes(@Ctx() ctx: RequestContext, @Param() p: IdParamDto, @Body() body: SetScopesDto) {
    return userView(await this.users.setScopes(ctx, p.id, body));
  }

  /** Signs the member out of every device (backend doc 8.30); acting on oneself keeps this session. */
  @Post(":id/sessions/revoke")
  @Isolation({ fixture: "user" })
  @ZodResponse({ status: 200, type: RevokedDto })
  async revokeSessions(@Ctx() ctx: RequestContext, @Param() p: IdParamDto, @Req() req: AuthedRequest) {
    return { revoked: await this.users.revokeSessions(ctx, p.id, req.sessionToken) };
  }

  /** Turns off a member's two-step verification (lost phone and backup codes) and signs them out. */
  @Post(":id/two-factor/reset")
  @Isolation({ fixture: "user" })
  @ZodResponse({ status: 200, type: UserDto })
  async resetTwoFactor(@Ctx() ctx: RequestContext, @Param() p: IdParamDto) {
    return userView(await this.users.resetTwoFactor(ctx, p.id));
  }
}

@ApiTags("roles")
@Controller("v1")
@RequirePermission("settings:user")
export class RolesController {
  constructor(@Inject(RolesService) private readonly roles: RolesService) {}

  @Get("roles")
  @Isolation({ fixture: "role" })
  @ZodResponse({ type: RoleListDto })
  async list(@Ctx() ctx: RequestContext) {
    return { items: await this.roles.list(ctx), next_cursor: null };
  }

  /** The permission catalogue is global reference data. */
  @Get("permissions")
  @Isolation("global")
  @ZodResponse({ type: PermissionListDto })
  async permissions(@Ctx() ctx: RequestContext) {
    return { items: await this.roles.permissions(ctx), next_cursor: null };
  }
}

@ApiTags("invitations")
@Controller("v1/invitations")
@RequirePermission("settings:user")
export class InvitationsController {
  constructor(@Inject(InvitationsService) private readonly invitations: InvitationsService) {}

  @Get()
  @Isolation({ fixture: "invitation" })
  @ZodResponse({ type: InvitationPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: PageQueryDto) {
    return this.invitations.list(ctx, q.cursor, q.limit).then((p) => ({
      items: p.items.map(invitationView),
      next_cursor: p.next_cursor,
    }));
  }

  @Post()
  @Isolation({ fixture: "invitation" })
  @ZodResponse({ status: 201, type: InvitationDto })
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateInvitationDto) {
    return invitationView(await this.invitations.invite(ctx, body));
  }

  @Post(":id/resend")
  @Isolation({ fixture: "invitation" })
  @ZodResponse({ status: 200, type: InvitationDto })
  async resend(@Ctx() ctx: RequestContext, @Param() p: IdParamDto) {
    return invitationView(await this.invitations.resend(ctx, p.id));
  }

  @Delete(":id")
  @Isolation({ fixture: "invitation" })
  @HttpCode(204)
  async revoke(@Ctx() ctx: RequestContext, @Param() p: IdParamDto): Promise<void> {
    await this.invitations.revoke(ctx, p.id);
  }
}
