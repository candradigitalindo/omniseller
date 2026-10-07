import { boolean, date, jsonb, pgTable, smallint, text, time } from "drizzle-orm/pg-core";
import { baseColumns, ulid } from "../columns";

/** Open and close on one day, "HH:MM" in the business's time zone; null when closed. */
export type DayHours = { open: string; close: string } | null;
/** Seven days from Sunday (0) to Saturday (6). */
export type WeekSchedule = DayHours[];

/** A courier's last pickup or drop-off at a warehouse (PRD FR-CMP-05, backend doc 8.31). */
export const courierCutoff = pgTable("courier_cutoff", {
  ...baseColumns(),
  warehouseId: ulid("warehouse_id").notNull(),
  courier: text("courier").notNull(),
  /** "HH:MM:SS" as PostgreSQL returns it */
  cutoffTime: time("cutoff_time").notNull(),
  daysOfWeek: smallint("days_of_week").array().notNull().default([1, 2, 3, 4, 5, 6]),
  active: boolean("active").notNull().default(true),
});

/** A day a courier, or every courier (`courier` null), does not pick up. */
export const courierHoliday = pgTable("courier_holiday", {
  ...baseColumns(),
  holidayDate: date("holiday_date", { mode: "string" }).notNull(),
  courier: text("courier"),
  note: text("note"),
});

/** The business's week (`isDefault`) and special periods that replace it on their dates (PRD FR-CMP-06). */
export const operatingHours = pgTable("operating_hours", {
  ...baseColumns(),
  name: text("name").notNull(),
  schedule: jsonb("schedule").$type<WeekSchedule>().notNull(),
  validFrom: date("valid_from", { mode: "string" }),
  validTo: date("valid_to", { mode: "string" }),
  isDefault: boolean("is_default").notNull().default(false),
});
