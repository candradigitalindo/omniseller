import { Inject, Injectable, Optional } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import { ENV } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { TenantsService } from "../identity/tenants.service";
import { UsersService } from "../identity/users.service";
import { EMAIL_SENDER, type EmailSender } from "./email";
import { InboxRepository } from "./inbox.repository";
import { notificationEmail } from "./templates";

const log = logger.forModule("notification.email");

/**
 * Worker only: sends an in-app notification by email to its recipient (job `notification.email`), unless
 * they left the business meanwhile. `channels_sent.email` records when it went out, so a retried job
 * does not send it twice.
 */
@Injectable()
export class NotificationEmailService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(InboxRepository) private readonly repo: InboxRepository,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(EMAIL_SENDER) private readonly email?: EmailSender,
  ) {}

  async send(ctx: RequestContext, notificationId: string): Promise<boolean> {
    if (!this.email) throw new Error("NotificationEmailService.send needs an EmailSender (worker process)");
    const n = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, notificationId));
    if (!n?.userId || n.channelsSent.email) return false;
    const principal = await this.users.loadPrincipal(ctx.tenantId, n.userId);
    if (principal?.user.status !== "active") return false;
    const tenant = await this.tenants.profile(ctx);
    const web = "PUBLIC_WEB_URL" in this.env ? this.env.PUBLIC_WEB_URL : "";
    await this.email.send(
      notificationEmail({
        to: principal.user.email,
        name: principal.user.name,
        tenantName: tenant.name,
        title: n.title,
        body: n.body,
        url: `${web}/`,
      }),
    );
    await withTenantTx(this.db, ctx, (tx) => this.repo.markSent(tx, n.id, "email", new Date()));
    log.info({ notification_id: n.id, kind: n.kind }, "notification emailed");
    return true;
  }
}
