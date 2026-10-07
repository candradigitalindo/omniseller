import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { RequestContext } from "../../common/context/request-context";
import { Ctx, Isolation, RequirePermission } from "../../common/http/decorators";
import { parseIfMatch } from "../../common/http/if-match";
import type { AuthedRequest } from "../../common/http/request";
import { IdParamDto } from "../identity/dto";
import { CourierCalendarService } from "./courier-calendar.service";
import {
  AddCutoffDto,
  AddHolidayDto,
  AddPeriodDto,
  CutoffDto,
  CutoffListDto,
  cutoffDto,
  HolidayDto,
  HolidayListDto,
  HolidayQueryDto,
  HoursDto,
  holidayDto,
  PeriodDto,
  periodDto,
  SetWeekDto,
  UpdateCutoffDto,
  UpdatePeriodDto,
  WeekDto,
  weekDto,
} from "./dto";

/** Kurir & Jam Operasional (UI L43, PRD FR-CMP-05, backend doc 8.31): who keeps the warehouses' schedule. */
@ApiTags("courier-cutoffs")
@Controller("v1/courier-cutoffs")
@RequirePermission("settings:warehouse")
export class CourierCutoffsController {
  constructor(@Inject(CourierCalendarService) private readonly calendar: CourierCalendarService) {}

  @Get()
  @Isolation({ fixture: "courier_cutoff" })
  @ZodResponse({ type: CutoffListDto })
  async list(@Ctx() ctx: RequestContext) {
    return { items: (await this.calendar.cutoffs(ctx)).map(cutoffDto), next_cursor: null };
  }

  @Post()
  @Isolation({ fixture: "warehouse" })
  @ZodResponse({ status: 201, type: CutoffDto })
  async add(@Ctx() ctx: RequestContext, @Body() body: AddCutoffDto) {
    return cutoffDto(await this.calendar.addCutoff(ctx, body));
  }

  @Patch(":id")
  @Isolation({ fixture: "courier_cutoff" })
  @ZodResponse({ type: CutoffDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param() p: IdParamDto,
    @Body() body: UpdateCutoffDto,
    @Req() req: AuthedRequest,
  ) {
    return cutoffDto(await this.calendar.updateCutoff(ctx, p.id, body, parseIfMatch(req)));
  }

  @Delete(":id")
  @HttpCode(204)
  @Isolation({ fixture: "courier_cutoff" })
  async remove(@Ctx() ctx: RequestContext, @Param() p: IdParamDto): Promise<void> {
    await this.calendar.removeCutoff(ctx, p.id);
  }
}

@ApiTags("courier-cutoffs")
@Controller("v1/courier-holidays")
@RequirePermission("settings:warehouse")
export class CourierHolidaysController {
  constructor(@Inject(CourierCalendarService) private readonly calendar: CourierCalendarService) {}

  @Get()
  @Isolation({ fixture: "courier_holiday" })
  @ZodResponse({ type: HolidayListDto })
  async list(@Ctx() ctx: RequestContext, @Query() q: HolidayQueryDto) {
    return { items: (await this.calendar.holidays(ctx, q.from)).map(holidayDto), next_cursor: null };
  }

  @Post()
  @Isolation("self")
  @ZodResponse({ status: 201, type: HolidayDto })
  async add(@Ctx() ctx: RequestContext, @Body() body: AddHolidayDto) {
    return holidayDto(await this.calendar.addHoliday(ctx, body));
  }

  @Delete(":id")
  @HttpCode(204)
  @Isolation({ fixture: "courier_holiday" })
  async remove(@Ctx() ctx: RequestContext, @Param() p: IdParamDto): Promise<void> {
    await this.calendar.removeHoliday(ctx, p.id);
  }
}

@ApiTags("courier-cutoffs")
@Controller("v1/operating-hours")
@RequirePermission("settings:warehouse")
export class OperatingHoursController {
  constructor(@Inject(CourierCalendarService) private readonly calendar: CourierCalendarService) {}

  @Get()
  @Isolation("self")
  @ZodResponse({ type: HoursDto })
  async get(@Ctx() ctx: RequestContext) {
    const h = await this.calendar.hours(ctx);
    return { week: h.week ? weekDto(h.week) : null, periods: h.periods.map(periodDto) };
  }

  @Put("week")
  @Isolation("self")
  @ZodResponse({ type: WeekDto })
  async setWeek(@Ctx() ctx: RequestContext, @Body() body: SetWeekDto) {
    return weekDto(await this.calendar.setWeek(ctx, body.schedule));
  }

  @Delete("week")
  @HttpCode(204)
  @Isolation("self")
  async removeWeek(@Ctx() ctx: RequestContext): Promise<void> {
    await this.calendar.removeWeek(ctx);
  }

  @Post("periods")
  @Isolation("self")
  @ZodResponse({ status: 201, type: PeriodDto })
  async addPeriod(@Ctx() ctx: RequestContext, @Body() body: AddPeriodDto) {
    return periodDto(await this.calendar.addPeriod(ctx, body));
  }

  @Patch("periods/:id")
  @Isolation({ fixture: "operating_hours" })
  @ZodResponse({ type: PeriodDto })
  async updatePeriod(@Ctx() ctx: RequestContext, @Param() p: IdParamDto, @Body() body: UpdatePeriodDto) {
    return periodDto(await this.calendar.updatePeriod(ctx, p.id, body));
  }

  @Delete("periods/:id")
  @HttpCode(204)
  @Isolation({ fixture: "operating_hours" })
  async removePeriod(@Ctx() ctx: RequestContext, @Param() p: IdParamDto): Promise<void> {
    await this.calendar.removePeriod(ctx, p.id);
  }
}
