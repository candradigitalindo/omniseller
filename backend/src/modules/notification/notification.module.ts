import { type DynamicModule, Global, Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { createEmailSender, EMAIL_SENDER } from "./email";
import { NotificationEmailService } from "./email.service";
import { EmailAttachments } from "./email-attachments";
import { NotificationsController } from "./inbox.controller";
import { InboxRepository } from "./inbox.repository";
import { NotificationInboxService } from "./inbox.service";
import { NotificationPreferencesService } from "./preferences.service";

/** Email delivery for the worker process (EMAIL_TRANSPORT, SMTP_URL, EMAIL_FROM). */
@Global()
@Module({})
export class NotificationModule {
  static forWorker(config: Parameters<typeof createEmailSender>[0]): DynamicModule {
    return {
      module: NotificationModule,
      providers: [{ provide: EMAIL_SENDER, useValue: createEmailSender(config) }],
      exports: [EMAIL_SENDER],
    };
  }
}

/**
 * In-app notifications (api and worker): other modules write them, users read their own. `EmailAttachments`
 * is one per process, so the sources other modules register reach the email job.
 */
@Module({
  imports: [IdentityModule],
  providers: [InboxRepository, NotificationInboxService, NotificationPreferencesService, EmailAttachments],
  exports: [InboxRepository, NotificationInboxService, NotificationPreferencesService, EmailAttachments],
})
export class NotificationInboxModule {}

@Module({ imports: [NotificationInboxModule], controllers: [NotificationsController] })
export class NotificationHttpModule {}

/** Worker only: notifications sent by email (job `notification.email`). */
@Module({
  imports: [NotificationInboxModule, IdentityModule],
  providers: [NotificationEmailService],
  exports: [NotificationEmailService],
})
export class NotificationWorkerModule {}
