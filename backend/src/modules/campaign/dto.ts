import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { CourierCutoffRow, CourierHolidayRow, OperatingHoursRow } from "./campaign.repository";
import { hhmm } from "./cutoff-plan";

/** Courier cut-offs, courier holidays, and operating hours (UI L43, backend doc 8.31). */

const date = z.iso.date();
const time = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Jam ditulis JJ:MM, misalnya 15:00.");
const courier = z.string().trim().min(1).max(60).describe("nama kurir seperti di marketplace, misalnya J&T Express");
const days = z
  .array(z.number().int().min(0).max(6))
  .min(1, "Pilih minimal satu hari.")
  .max(7)
  .describe("hari kurir datang: 0 = Minggu sampai 6 = Sabtu");
const dayHours = z.object({ open: time, close: time }).nullable().describe("null berarti tutup");
const week = z.array(dayHours).length(7).describe("tujuh hari dari Minggu");
const someField = <T extends Record<string, unknown>>(v: T) => Object.values(v).some((x) => x !== undefined);

// ---- cut-offs ----

export class AddCutoffDto extends createZodDto(
  z.object({ warehouseId: ulidSchema, courier, cutoffTime: time, days, active: z.boolean().optional() }),
) {}

export class UpdateCutoffDto extends createZodDto(
  z
    .object({
      courier: courier.optional(),
      cutoffTime: time.optional(),
      days: days.optional(),
      active: z.boolean().optional(),
    })
    .refine(someField, { message: "Tidak ada perubahan." }),
) {}

const cutoffSchema = z.object({
  id: ulidSchema,
  warehouseId: ulidSchema,
  courier: z.string(),
  cutoffTime: z.string().describe("JJ:MM, jam pickup atau drop-off terakhir"),
  days: z.array(z.number().int()),
  active: z.boolean(),
  rowVersion: z.number().int(),
});
export class CutoffDto extends createZodDto(cutoffSchema) {}
export class CutoffListDto extends createZodDto(z.object({ items: z.array(cutoffSchema), next_cursor: z.null() })) {}

export function cutoffDto(c: CourierCutoffRow) {
  return {
    id: c.id,
    warehouseId: c.warehouseId,
    courier: c.courier,
    cutoffTime: hhmm(c.cutoffTime),
    days: c.daysOfWeek,
    active: c.active,
    rowVersion: c.rowVersion,
  };
}

// ---- holidays ----

export class HolidayQueryDto extends createZodDto(
  z.object({ from: date.optional().describe("bawaan: 30 hari lalu") }),
) {}

export class AddHolidayDto extends createZodDto(
  z.object({
    date,
    courier: courier.nullable().optional().describe("kosong: semua kurir"),
    note: z.string().trim().max(120).nullable().optional(),
  }),
) {}

const holidaySchema = z.object({
  id: ulidSchema,
  date: z.string(),
  courier: z.string().nullable(),
  note: z.string().nullable(),
});
export class HolidayDto extends createZodDto(holidaySchema) {}
export class HolidayListDto extends createZodDto(z.object({ items: z.array(holidaySchema), next_cursor: z.null() })) {}

export function holidayDto(h: CourierHolidayRow) {
  return { id: h.id, date: h.holidayDate, courier: h.courier, note: h.note };
}

// ---- operating hours ----

export class SetWeekDto extends createZodDto(z.object({ schedule: week })) {}

export class AddPeriodDto extends createZodDto(
  z.object({ name: z.string().trim().min(1).max(60), from: date, to: date, schedule: week }),
) {}

export class UpdatePeriodDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(60).optional(),
      from: date.optional(),
      to: date.optional(),
      schedule: week.optional(),
    })
    .refine(someField, { message: "Tidak ada perubahan." }),
) {}

const weekSchema = z.object({ id: ulidSchema, schedule: week, rowVersion: z.number().int() });
const periodSchema = z.object({ id: ulidSchema, name: z.string(), from: z.string(), to: z.string(), schedule: week });
export class WeekDto extends createZodDto(weekSchema) {}
export class PeriodDto extends createZodDto(periodSchema) {}
export class HoursDto extends createZodDto(
  z.object({
    week: weekSchema.nullable().describe("minggu biasa; null bila belum diatur (tidak membatasi)"),
    periods: z.array(periodSchema).describe("periode khusus yang menggantikan minggu biasa pada tanggalnya"),
  }),
) {}

export const weekDto = (h: OperatingHoursRow) => ({ id: h.id, schedule: h.schedule, rowVersion: h.rowVersion });
export const periodDto = (h: OperatingHoursRow) => ({
  id: h.id,
  name: h.name,
  from: h.validFrom ?? "",
  to: h.validTo ?? "",
  schedule: h.schedule,
});
