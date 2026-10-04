import { pgTable, text } from "drizzle-orm/pg-core";
import { ulid } from "../columns";

const transitionColumns = () => ({
  id: ulid("id").primaryKey(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  via: text("via").$type<"any" | "marketplace">().notNull().default("any"),
});

/** Global, seeded by drizzle/sql/90_seeds.sql; read by enforce_status_transition(). */
export const orderStatusTransition = pgTable("order_status_transition", transitionColumns());
export const shipmentStatusTransition = pgTable("shipment_status_transition", transitionColumns());
export const syncJobStatusTransition = pgTable("sync_job_status_transition", transitionColumns());
export const documentJobStatusTransition = pgTable("document_job_status_transition", transitionColumns());
export const dataExportStatusTransition = pgTable("data_export_status_transition", transitionColumns());
export const migrationJobStatusTransition = pgTable("migration_job_status_transition", transitionColumns());
export const storeCutoverStatusTransition = pgTable("store_cutover_status_transition", transitionColumns());
export const printJobStatusTransition = pgTable("print_job_status_transition", transitionColumns());
export const handoverStatusTransition = pgTable("handover_status_transition", transitionColumns());
