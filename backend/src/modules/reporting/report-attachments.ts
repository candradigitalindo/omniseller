import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { type RequestContext, userContext } from "../../common/context/request-context";
import { DomainError } from "../../common/errors/domain-errors";
import { XLSX_MIME } from "../../common/xlsx";
import { UsersService } from "../identity/users.service";
import type { EmailAttachment } from "../notification/email";
import { type AttachingNotification, EmailAttachments } from "../notification/email-attachments";
import { SalesReportService } from "./sales-report.service";
import { reportKindOf } from "./scheduled-report-plan";
import { StaffReportService } from "./staff-report.service";

/** Workbooks drawn at once in this process: a Monday morning fans out one per recipient. */
const DRAW_CONCURRENCY = 2;

/**
 * The Excel workbook of a scheduled report email (backend doc 8.20), drawn when `notification.email` sends
 * it, for the recipient's own permissions and store or warehouse scope. Never stored. No file when the
 * person may no longer see the report or the plan lost the feature meanwhile: the email still goes.
 */
@Injectable()
export class ReportAttachments implements OnModuleInit {
  private readonly log = logger.forModule("reporting.attachments");
  private drawing = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    @Inject(EmailAttachments) private readonly attachments: EmailAttachments,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SalesReportService) private readonly sales: SalesReportService,
    @Inject(StaffReportService) private readonly staff: StaffReportService,
  ) {}

  onModuleInit(): void {
    this.attachments.register((ctx, n) => this.for(ctx, n));
  }

  async for(ctx: RequestContext, n: AttachingNotification): Promise<EmailAttachment[]> {
    const kind = reportKindOf(n.kind);
    const from = n.data.from;
    const to = n.data.to;
    if (!kind || !n.userId || typeof from !== "string" || typeof to !== "string") return [];
    const principal = await this.users.loadPrincipal(ctx.tenantId, n.userId);
    if (principal?.user.status !== "active" || !principal.permissions.includes(kind.permission)) {
      this.log.info({ notification_kind: n.kind, user_id: n.userId }, "report not drawn: no longer allowed");
      return [];
    }
    const reader = userContext(ctx, principal);
    await this.acquire();
    try {
      const file =
        kind.report === "sales"
          ? await this.sales.workbook(reader, { from, to, granularity: "day", compare: true })
          : await this.staff.workbook(reader, { from, to });
      return [{ filename: file.fileName, contentType: XLSX_MIME, content: file.bytes }];
    } catch (err) {
      // the plan lost the team report, or the period is refused: the email goes without the file
      if (!(err instanceof DomainError)) throw err;
      this.log.info({ notification_kind: n.kind, user_id: n.userId, code: err.code }, "report not drawn");
      return [];
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.drawing < DRAW_CONCURRENCY) {
      this.drawing++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.drawing++;
        resolve();
      });
    });
  }

  private release(): void {
    this.drawing--;
    this.waiting.shift()?.();
  }
}
