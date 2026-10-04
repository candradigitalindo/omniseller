import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation } from "../../common/http/decorators";
import { decodeCursor, encodeCursor } from "../../common/http/pagination";
import {
  MarkedDto,
  MarkReadDto,
  NotificationPageDto,
  NotificationQueryDto,
  notificationView,
  PreferenceKindParamDto,
  PreferenceListDto,
  SetPreferenceDto,
  UnreadCountDto,
} from "./dto";
import { NotificationInboxService } from "./inbox.service";
import { NotificationPreferencesService } from "./preferences.service";

/** The signed-in user's in-app notifications (FR-NTF-01): every user reads only their own. */
@ApiTags("notifications")
@Controller("v1/notifications")
export class NotificationsController {
  constructor(
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
    @Inject(NotificationPreferencesService) private readonly preferences: NotificationPreferencesService,
  ) {}

  @Get()
  @Isolation("self")
  @ZodResponse({ type: NotificationPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: NotificationQueryDto) {
    const page = await this.inbox.list(ctx, {
      unreadOnly: q.unread === "true",
      before: decodeCursor(q.cursor),
      limit: q.limit,
    });
    const last = page.items[page.items.length - 1];
    return { items: page.items.map(notificationView), next_cursor: page.more && last ? encodeCursor(last.id) : null };
  }

  @Get("unread-count")
  @Isolation("self")
  @ZodResponse({ type: UnreadCountDto })
  async unread(@Ctx() ctx: RequestContext) {
    return { unread: await this.inbox.unreadCount(ctx) };
  }

  @Post("read")
  @HttpCode(200)
  @Isolation("self")
  @ZodResponse({ type: MarkedDto })
  async markRead(@Ctx() ctx: RequestContext, @Body() body: MarkReadDto) {
    return { marked: await this.inbox.markRead(ctx, body.all ? null : (body.ids ?? [])) };
  }

  /** The caller's own choices (UI L44); for now the daily operational email (FR-NTF-02). */
  @Get("preferences")
  @Isolation("self")
  @ZodResponse({ type: PreferenceListDto })
  async listPreferences(@Ctx() ctx: RequestContext) {
    return { items: await this.preferences.list(ctx) };
  }

  @Put("preferences/:kind")
  @Isolation("self")
  @ZodResponse({ type: PreferenceListDto })
  async setPreference(@Ctx() ctx: RequestContext, @Param() p: PreferenceKindParamDto, @Body() body: SetPreferenceDto) {
    await this.preferences.set(ctx, p.kind, body);
    return { items: await this.preferences.list(ctx) };
  }
}
