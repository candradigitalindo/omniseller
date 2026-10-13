import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { hasFeature } from "../../common/plan-features";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { TenantsService } from "../identity/tenants.service";
import { UsersService } from "../identity/users.service";
import { type NewNotification, NotificationInboxService } from "../notification/inbox.service";
import { NotificationPreferencesService } from "../notification/preferences.service";
import { ScheduledReportRepository } from "./scheduled-report.repository";
import { type ReportCadence, reportBody, reportKindsOf, reportTitle } from "./scheduled-report-plan";

export interface ScheduledRun {
  cadence: ReportCadence;
  /** The business's local dates the reports cover. */
  periodStart: string;
  periodEnd: string;
}

/**
 * Scheduled report emails (PRD FR-RPT-05, backend doc 8.20), worker only. Job `report.scheduled` claims a
 * business's period once, then writes one emailed notification per person who chose the report (UI L44);
 * `notification.email` sends each with the workbook drawn for that person by `ReportAttachments`.
 */
@Injectable()
export class ScheduledReportService {
  private readonly log = logger.forModule("reporting.scheduled");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ScheduledReportRepository) private readonly repo: ScheduledReportRepository,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(NotificationPreferencesService) private readonly preferences: NotificationPreferencesService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  /** Plans the period's emails; how many, or 0 when the period was done already. */
  async run(ctx: RequestContext, p: ScheduledRun): Promise<number> {
    const planned = await withTenantTx(this.db, ctx, async (tx) => {
      const run = await this.repo.claim(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        cadence: p.cadence,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
      });
      if (!run) return 0;
      const plan = await this.tenants.planIn(tx, ctx);
      const period = { from: p.periodStart, to: p.periodEnd };
      const notes: NewNotification[] = [];
      for (const kind of reportKindsOf(p.cadence)) {
        // a report the plan no longer includes goes to nobody; the choices stay for a move back up
        if (kind.feature && !hasFeature(plan, kind.feature)) continue;
        const choices = await this.preferences.emailChoicesIn(tx, kind.kind);
        for (const u of await this.users.recipientsIn(tx, kind.permission)) {
          if (choices.get(u.id) !== true) continue;
          notes.push({
            userId: u.id,
            kind: kind.kind,
            severity: "info",
            title: reportTitle(kind.report, kind.cadence, period),
            body: reportBody(kind.report),
            data: { report: kind.report, cadence: kind.cadence, from: period.from, to: period.to },
          });
        }
      }
      if (notes.length > 0) await this.inbox.notifyIn(tx, ctx, notes, { email: true });
      await this.repo.setRecipients(tx, run.id, notes.length);
      return notes.length;
    });
    this.log.info(
      { tenant_id: ctx.tenantId, cadence: p.cadence, period_start: p.periodStart, recipients: planned },
      "scheduled reports planned",
    );
    return planned;
  }
}
