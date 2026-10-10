import { AUTOMATION_JOBS } from "../modules/automation/automation.jobs";
import { BILLING_JOBS } from "../modules/billing/billing.jobs";
import { BUSINESS_JOBS } from "../modules/business/business.jobs";
import { CATALOG_JOBS } from "../modules/catalog/catalog.jobs";
import { CHANNEL_JOBS } from "../modules/channel/channel.jobs";
import { CLOSURE_JOBS } from "../modules/closure/closure.jobs";
import { EXPORT_JOBS } from "../modules/exports/exports.jobs";
import { FILES_JOBS } from "../modules/files/files.jobs";
import { FULFILLMENT_JOBS } from "../modules/fulfillment/fulfillment.jobs";
import { IDENTITY_JOBS } from "../modules/identity/identity.jobs";
import { INVENTORY_JOBS } from "../modules/inventory/inventory.jobs";
import { LISTING_COPY_JOBS } from "../modules/listing-copy/listing-copy.jobs";
import { MIGRATION_JOBS } from "../modules/migration/migration.jobs";
import { NOTIFICATION_JOBS } from "../modules/notification/notification.jobs";
import { ORDER_JOBS } from "../modules/orders/orders.jobs";
import { REPORTING_JOBS } from "../modules/reporting/reporting.jobs";
import { RETENTION_JOBS } from "../modules/retention/retention.jobs";
import { RETURN_JOBS } from "../modules/returns/returns.jobs";
import { SYNC_JOBS } from "../modules/sync/sync.jobs";
import type { EventDef, JobDef } from "./define";

/**
 * All jobs and events known to the process (backend doc 9.1). Modules add their definitions here;
 * test/jobs checks that every event consumer is registered and names are unique.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobDef>();
  private readonly consumers = new Map<string, JobDef[]>();

  constructor(defs: readonly JobDef[] = []) {
    for (const def of defs) this.register(def);
  }

  register(def: JobDef): void {
    const key = `${def.queue}/${def.name}`;
    if (this.jobs.has(key)) throw new Error(`job registered twice: ${key}`);
    this.jobs.set(key, def);
    for (const event of def.triggeredBy ?? []) {
      const list = this.consumers.get(event.type) ?? [];
      list.push(def);
      this.consumers.set(event.type, list);
    }
  }

  get(queue: string, name: string): JobDef | undefined {
    return this.jobs.get(`${queue}/${name}`);
  }

  consumersOf(event: EventDef): readonly JobDef[] {
    return this.consumers.get(event.type) ?? [];
  }

  all(): readonly JobDef[] {
    return [...this.jobs.values()];
  }

  queues(): string[] {
    return [...new Set(this.all().map((j) => j.queue))];
  }
}

/** Registered jobs; each module appends its definitions here. */
export const JOB_DEFINITIONS: readonly JobDef[] = [
  ...NOTIFICATION_JOBS,
  ...IDENTITY_JOBS,
  ...CHANNEL_JOBS,
  ...CATALOG_JOBS,
  ...LISTING_COPY_JOBS,
  ...INVENTORY_JOBS,
  ...ORDER_JOBS,
  ...AUTOMATION_JOBS,
  ...FULFILLMENT_JOBS,
  ...RETURN_JOBS,
  ...EXPORT_JOBS,
  ...MIGRATION_JOBS,
  ...REPORTING_JOBS,
  ...RETENTION_JOBS,
  ...CLOSURE_JOBS,
  ...BUSINESS_JOBS,
  ...BILLING_JOBS,
  ...FILES_JOBS,
  ...SYNC_JOBS,
];
