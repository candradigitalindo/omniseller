import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";
import {
  periodBefore,
  REPORT_CADENCES,
  type ReportCadence,
  sendsFrom,
} from "../modules/reporting/scheduled-report-plan";

/** How often businesses are looked at for a weekly or monthly report that is due. */
export const REPORT_SCAN_MS = 15 * 60_000;
/** A business's job waits up to this long after the scan, so one time zone's Monday mornings spread out. */
export const REPORT_SPREAD_MS = 45 * 60_000;

/** A fixed moment within the spread for a business, so every scan of the hour picks the same one. */
export function scanDelayMs(tenantId: string): number {
  let h = 0;
  for (const ch of tenantId) h = (h * 31 + ch.charCodeAt(0)) % 1_000_003;
  return h % REPORT_SPREAD_MS;
}

export interface DueReport {
  tenantId: string;
  cadence: ReportCadence;
  periodStart: string;
  periodEnd: string;
}

/**
 * The periods a business should be emailed now: the week before, from Monday 07.00 local, and the month
 * before, from the 1st at 07.00 local, until that week or month is over (a scheduler down on Monday sends
 * on Tuesday); never a period that ended before the business existed.
 */
export function dueReports(t: { id: string; localDate: string; localHour: number; createdOn: string }): DueReport[] {
  const out: DueReport[] = [];
  for (const cadence of REPORT_CADENCES) {
    const period = periodBefore(cadence, t.localDate);
    const sends = sendsFrom(period);
    const due = t.localDate > sends.date || (t.localDate === sends.date && t.localHour >= sends.hour);
    if (due && period.to >= t.createdOn) {
      out.push({ tenantId: t.id, cadence, periodStart: period.from, periodEnd: period.to });
    }
  }
  return out;
}

/**
 * `report.scan` (every 15 minutes): one `report.scheduled` job per business and due period that has no
 * run row yet. The id carries the hour, so a job that failed its attempts is queued again an hour later
 * while the run row keeps every period once (backend doc 8.20, 9.2).
 */
export async function scanScheduledReports(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
  opts: { spreadMs?: number } = {},
): Promise<number> {
  const spread = opts.spreadMs ?? REPORT_SPREAD_MS;
  const at = sql`${now.toISOString()}::timestamptz`;
  const due = await withSystemTx(system, async (tx) => {
    const tenants = await tx.execute<{ id: string; local_date: string; local_hour: number; created_on: string }>(sql`
      SELECT t.id,
             to_char(${at} AT TIME ZONE t.timezone, 'YYYY-MM-DD') AS local_date,
             extract(hour FROM ${at} AT TIME ZONE t.timezone)::int AS local_hour,
             to_char(t.created_at AT TIME ZONE t.timezone, 'YYYY-MM-DD') AS created_on
        FROM tenant t
       WHERE t.status = 'active' AND t.created_at < ${at} - interval '1 day'
       LIMIT 2000`);
    const candidates = tenants.rows.flatMap((r) =>
      dueReports({ id: r.id, localDate: r.local_date, localHour: Number(r.local_hour), createdOn: r.created_on }),
    );
    if (candidates.length === 0) return [];
    const done = await tx.execute<{ tenant_id: string; cadence: string; period_start: string }>(sql`
      SELECT tenant_id, cadence, to_char(period_start, 'YYYY-MM-DD') AS period_start
        FROM report_schedule_run
       WHERE (tenant_id, cadence, period_start) IN (${sql.join(
         candidates.map((c) => sql`(${c.tenantId}::ulid, ${c.cadence}, ${c.periodStart}::date)`),
         sql`, `,
       )})`);
    const claimed = new Set(done.rows.map((r) => `${r.tenant_id}|${r.cadence}|${r.period_start}`));
    return candidates.filter((c) => !claimed.has(`${c.tenantId}|${c.cadence}|${c.periodStart}`));
  });
  const def = registry.get("notify", "report.scheduled");
  if (!def) throw new Error("job notify/report.scheduled is not registered");
  const slot = `h${Math.floor(now.getTime() / 3_600_000)}`;
  for (const d of due) {
    const payload = {
      tenantId: d.tenantId,
      cadence: d.cadence,
      periodStart: d.periodStart,
      periodEnd: d.periodEnd,
      slot,
    };
    await queues.get(def.queue).add(def.name, payload, {
      ...def.options,
      delay: spread > 0 ? scanDelayMs(d.tenantId) % spread : 0,
      jobId: jobKey("report.scheduled", d.tenantId, d.cadence, d.periodStart, slot),
    });
  }
  return due.length;
}
