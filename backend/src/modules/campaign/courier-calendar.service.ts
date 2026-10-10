import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { ConflictError } from "../../common/errors/domain-errors";
import { findPgError } from "../../common/errors/problem";
import type { ExportSheet } from "../../common/export-sheet";
import { singlePage } from "../../common/export-sheet";
import { localDate } from "../../common/time-zone";
import type { DbHandle, Tx } from "../../db/client";
import type { WeekSchedule } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { TenantsService } from "../identity/tenants.service";
import { InventoryService } from "../inventory/inventory.service";
import {
  cutoffDuplicate,
  cutoffNotFound,
  holidayDuplicate,
  holidayNotFound,
  hoursNotFound,
  periodDates,
  periodOverlap,
  warehouseInvalid,
  weekInvalid,
} from "./campaign.errors";
import { courierCalendarChanged } from "./campaign.events";
import {
  CampaignRepository,
  type CourierCutoffRow,
  type CourierHolidayRow,
  type OperatingHoursRow,
} from "./campaign.repository";
import { addDays, type CourierCalendarInput, hhmm, SEARCH_DAYS, weekProblem } from "./cutoff-plan";

export interface CutoffInput {
  warehouseId: string;
  courier: string;
  cutoffTime: string;
  days: number[];
  active?: boolean | undefined;
}
export type CutoffPatch = Partial<Omit<CutoffInput, "warehouseId">>;
export interface HolidayInput {
  date: string;
  courier?: string | null | undefined;
  note?: string | null | undefined;
}
export interface PeriodInput {
  name: string;
  from: string;
  to: string;
  schedule: WeekSchedule;
}

/** Orders waiting longer than this are rare; their deadline ignores holidays before it. */
const HOLIDAYS_BACK = 60;
const stale = () => new ConflictError("row.stale", "Data sudah diubah orang lain. Muat ulang lalu coba lagi.");
const WEEK_MESSAGES: Record<string, string> = {
  week: "Jam operasional berisi tujuh hari, Minggu sampai Sabtu.",
  time: "Jam ditulis JJ:MM, misalnya 08:00.",
  closeBeforeOpen: "Jam tutup harus setelah jam buka.",
};
const checkWeek = (week: WeekSchedule) => {
  const problem = weekProblem(week);
  if (problem) throw weekInvalid(WEEK_MESSAGES[problem] ?? problem);
};
/** The default week and the special periods of `operating_hours` rows. */
const weekAndPeriods = (hours: OperatingHoursRow[]): Pick<CourierCalendarInput, "week" | "periods"> => ({
  week: hours.find((h) => h.isDefault)?.schedule ?? null,
  periods: hours
    .filter((h) => !h.isDefault && h.validFrom && h.validTo)
    .map((h) => ({ from: h.validFrom!, to: h.validTo!, schedule: h.schedule })),
});
/** "J&T  Express " typed as "J&T Express". */
const cleanName = (name: string) => name.trim().replace(/\s+/g, " ");
const sortDays = (days: number[]) => [...new Set(days)].sort((a, b) => a - b);

/**
 * Courier cut-offs, courier holidays, and operating hours (PRD FR-CMP-05, 06; UI L43; backend doc 8.31).
 * Every change asks for the internal deadlines of orders to ship again (`courier_calendar.changed`), and
 * `calendarIn` gives the orders module what it computes them from.
 */
@Injectable()
export class CourierCalendarService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(CampaignRepository) private readonly repo: CampaignRepository,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  /**
   * What internal deadlines are computed from, in the caller's transaction: null when the business has
   * no active cut-off, so orders cost one small query when the feature is not used. Holidays from
   * HOLIDAYS_BACK days ago (orders still waiting since then) to as far as the deadline search looks.
   */
  async calendarIn(tx: Tx, ctx: RequestContext): Promise<CourierCalendarInput | null> {
    const cutoffs = await this.repo.cutoffs(tx, true);
    if (cutoffs.length === 0) return null;
    const { timezone } = await this.tenants.profileIn(tx, ctx);
    const today = localDate(timezone, new Date());
    const holidays = await this.repo.holidays(tx, addDays(today, -HOLIDAYS_BACK), addDays(today, SEARCH_DAYS + 1));
    return {
      timezone,
      cutoffs: cutoffs.map((c) => ({
        warehouseId: c.warehouseId,
        courier: c.courier,
        time: c.cutoffTime,
        days: c.daysOfWeek,
      })),
      holidays: holidays.map((h) => ({ date: h.holidayDate, courier: h.courier })),
      ...weekAndPeriods(await this.repo.hours(tx)),
    };
  }

  /**
   * The business's operating hours in the caller's transaction, for automatic order rules that act only
   * while it is open (FR-CMP-06, backend doc 8.37); null when it set none.
   */
  async businessHoursIn(
    tx: Tx,
    ctx: RequestContext,
  ): Promise<Pick<CourierCalendarInput, "timezone" | "week" | "periods"> | null> {
    const hours = await this.repo.hours(tx);
    if (hours.length === 0) return null;
    const { timezone } = await this.tenants.profileIn(tx, ctx);
    return { timezone, ...weekAndPeriods(hours) };
  }

  // ---- cut-offs ----

  /** Cut-offs of the warehouses the caller may see. */
  async cutoffs(ctx: RequestContext): Promise<CourierCutoffRow[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const visible = new Set((await this.inventory.warehousesIn(tx, ctx)).map((w) => w.id));
      return (await this.repo.cutoffs(tx)).filter((c) => visible.has(c.warehouseId));
    });
  }

  async addCutoff(ctx: RequestContext, input: CutoffInput): Promise<CourierCutoffRow> {
    return this.unique(cutoffDuplicate, "courier_cutoff_courier_uq", () =>
      withTenantTx(this.db, ctx, async (tx) => {
        if ((await this.inventory.warehousesIn(tx, ctx, input.warehouseId)).length === 0) throw warehouseInvalid();
        const id = newId();
        await this.repo.insertCutoff(tx, {
          id,
          tenantId: ctx.tenantId,
          warehouseId: input.warehouseId,
          courier: cleanName(input.courier),
          cutoffTime: input.cutoffTime,
          daysOfWeek: sortDays(input.days),
          active: input.active ?? true,
        });
        await this.changed(tx, ctx);
        return (await this.repo.cutoff(tx, id))!;
      }),
    );
  }

  async updateCutoff(ctx: RequestContext, id: string, patch: CutoffPatch, ifMatch?: number): Promise<CourierCutoffRow> {
    return this.unique(cutoffDuplicate, "courier_cutoff_courier_uq", () =>
      withTenantTx(this.db, ctx, async (tx) => {
        const current = await this.visibleCutoff(tx, ctx, id);
        const ok = await this.repo.updateCutoff(
          tx,
          current.id,
          {
            ...(patch.courier !== undefined ? { courier: cleanName(patch.courier) } : {}),
            ...(patch.cutoffTime !== undefined ? { cutoffTime: patch.cutoffTime } : {}),
            ...(patch.days !== undefined ? { daysOfWeek: sortDays(patch.days) } : {}),
            ...(patch.active !== undefined ? { active: patch.active } : {}),
          },
          ifMatch,
        );
        if (!ok) throw stale();
        await this.changed(tx, ctx);
        return (await this.repo.cutoff(tx, id))!;
      }),
    );
  }

  async removeCutoff(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const current = await this.visibleCutoff(tx, ctx, id);
      await this.repo.deleteCutoff(tx, current.id);
      await this.changed(tx, ctx);
    });
  }

  // ---- holidays ----

  /** Holidays from `from` on (default: 30 days ago), soonest first. */
  async holidays(ctx: RequestContext, from?: string): Promise<CourierHolidayRow[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const { timezone } = await this.tenants.profileIn(tx, ctx);
      return this.repo.holidays(tx, from ?? addDays(localDate(timezone, new Date()), -30));
    });
  }

  async addHoliday(ctx: RequestContext, input: HolidayInput): Promise<CourierHolidayRow> {
    return this.unique(holidayDuplicate, "courier_holiday_uq", () =>
      withTenantTx(this.db, ctx, async (tx) => {
        const id = newId();
        const courier = input.courier ? cleanName(input.courier) : null;
        await this.repo.insertHoliday(tx, {
          id,
          tenantId: ctx.tenantId,
          holidayDate: input.date,
          courier: courier || null,
          note: input.note?.trim() || null,
        });
        await this.changed(tx, ctx);
        return (await this.repo.holidays(tx, input.date, input.date)).find((h) => h.id === id)!;
      }),
    );
  }

  async removeHoliday(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      if (!(await this.repo.deleteHoliday(tx, id))) throw holidayNotFound();
      await this.changed(tx, ctx);
    });
  }

  // ---- operating hours ----

  async hours(ctx: RequestContext): Promise<{ week: OperatingHoursRow | null; periods: OperatingHoursRow[] }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const rows = await this.repo.hours(tx);
      return { week: rows.find((r) => r.isDefault) ?? null, periods: rows.filter((r) => !r.isDefault) };
    });
  }

  /** The usual week: set, or replaced. */
  async setWeek(ctx: RequestContext, schedule: WeekSchedule): Promise<OperatingHoursRow> {
    checkWeek(schedule);
    return withTenantTx(this.db, ctx, async (tx) => {
      const current = await this.repo.defaultWeek(tx, true);
      const id = current?.id ?? newId();
      if (current) await this.repo.updateHours(tx, id, { schedule });
      else {
        await this.repo.insertHours(tx, {
          id,
          tenantId: ctx.tenantId,
          name: "Minggu biasa",
          schedule,
          isDefault: true,
        });
      }
      await this.changed(tx, ctx);
      return (await this.repo.hoursRow(tx, id))!;
    });
  }

  /** Without a usual week, only special periods limit the hours. */
  async removeWeek(ctx: RequestContext): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const current = await this.repo.defaultWeek(tx, true);
      if (!current) throw hoursNotFound();
      await this.repo.deleteHours(tx, current.id);
      await this.changed(tx, ctx);
    });
  }

  async addPeriod(ctx: RequestContext, input: PeriodInput): Promise<OperatingHoursRow> {
    checkWeek(input.schedule);
    if (input.to < input.from) throw periodDates();
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.lockHours(tx, ctx.tenantId);
      const overlap = (await this.repo.overlappingPeriods(tx, input.from, input.to))[0];
      if (overlap) throw periodOverlap(overlap.name);
      const id = newId();
      await this.repo.insertHours(tx, {
        id,
        tenantId: ctx.tenantId,
        name: input.name.trim(),
        schedule: input.schedule,
        validFrom: input.from,
        validTo: input.to,
        isDefault: false,
      });
      await this.changed(tx, ctx);
      return (await this.repo.hoursRow(tx, id))!;
    });
  }

  async updatePeriod(ctx: RequestContext, id: string, patch: Partial<PeriodInput>): Promise<OperatingHoursRow> {
    if (patch.schedule) checkWeek(patch.schedule);
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.lockHours(tx, ctx.tenantId);
      const current = await this.repo.hoursRow(tx, id, true);
      if (!current || current.isDefault) throw hoursNotFound();
      const from = patch.from ?? current.validFrom!;
      const to = patch.to ?? current.validTo!;
      if (to < from) throw periodDates();
      const overlap = (await this.repo.overlappingPeriods(tx, from, to, id))[0];
      if (overlap) throw periodOverlap(overlap.name);
      await this.repo.updateHours(tx, id, {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        validFrom: from,
        validTo: to,
      });
      await this.changed(tx, ctx);
      return (await this.repo.hoursRow(tx, id))!;
    });
  }

  async removePeriod(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const current = await this.repo.hoursRow(tx, id, true);
      if (!current || current.isDefault) throw hoursNotFound();
      await this.repo.deleteHours(tx, id);
      await this.changed(tx, ctx);
    });
  }

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "cutoff_kurir.csv",
        description: "Cut-off kurir per gudang: jam pickup atau drop-off terakhir dan hari kurir datang (0 = Minggu).",
        columns: ["gudang", "kurir", "jam_cutoff", "hari", "aktif"],
        pages: (tx, lookups) =>
          singlePage(async () =>
            (await this.repo.cutoffs(tx)).map((c) => [
              lookups.warehouseCode(c.warehouseId),
              c.courier,
              hhmm(c.cutoffTime),
              c.daysOfWeek.join(","),
              c.active,
            ]),
          ),
      },
      {
        file: "libur_kurir.csv",
        description: "Hari libur kurir; kurir kosong berarti semua kurir.",
        columns: ["tanggal", "kurir", "catatan"],
        pages: (tx) =>
          singlePage(async () => (await this.repo.holidays(tx)).map((h) => [h.holidayDate, h.courier, h.note])),
      },
      {
        file: "jam_operasional.csv",
        description: "Jam operasional: minggu biasa dan periode khusus, per hari dari Minggu; kosong berarti tutup.",
        columns: [
          "nama",
          "berlaku_dari",
          "berlaku_sampai",
          "minggu",
          "senin",
          "selasa",
          "rabu",
          "kamis",
          "jumat",
          "sabtu",
        ],
        pages: (tx) =>
          singlePage(async () =>
            (await this.repo.hours(tx)).map((h) => [
              h.name,
              h.validFrom,
              h.validTo,
              ...h.schedule.map((d) => (d ? `${d.open}-${d.close}` : null)),
            ]),
          ),
      },
    ];
  }

  private async visibleCutoff(tx: Tx, ctx: RequestContext, id: string): Promise<CourierCutoffRow> {
    const current = await this.repo.cutoff(tx, id, true);
    if (!current || (await this.inventory.warehousesIn(tx, ctx, current.warehouseId)).length === 0) {
      throw cutoffNotFound();
    }
    return current;
  }

  private async changed(tx: Tx, ctx: RequestContext): Promise<void> {
    await this.outbox.enqueue(tx, ctx, courierCalendarChanged, {}, ctx.tenantId);
  }

  /** Maps the unique index of a duplicate to its domain error (the transaction is already rolled back). */
  private async unique<T>(error: () => Error, index: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (findPgError(e)?.constraint === index) throw error();
      throw e;
    }
  }
}
