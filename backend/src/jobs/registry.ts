import { CATALOG_JOBS } from "../modules/catalog/catalog.jobs";
import { CHANNEL_JOBS } from "../modules/channel/channel.jobs";
import { IDENTITY_JOBS } from "../modules/identity/identity.jobs";
import { INVENTORY_JOBS } from "../modules/inventory/inventory.jobs";
import { ORDER_JOBS } from "../modules/orders/orders.jobs";
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
  ...IDENTITY_JOBS,
  ...CHANNEL_JOBS,
  ...CATALOG_JOBS,
  ...INVENTORY_JOBS,
  ...ORDER_JOBS,
  ...SYNC_JOBS,
];
