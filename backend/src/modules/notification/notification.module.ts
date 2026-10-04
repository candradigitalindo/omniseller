import { type DynamicModule, Global, Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { createEmailSender, EMAIL_SENDER } from "./email";
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

/** In-app notifications (api and worker): other modules write them, users read their own. */
@Module({
  imports: [IdentityModule],
  providers: [InboxRepository, NotificationInboxService, NotificationPreferencesService],
  exports: [NotificationInboxService, NotificationPreferencesService],
})
export class NotificationInboxModule {}

@Module({ imports: [NotificationInboxModule], controllers: [NotificationsController] })
export class NotificationHttpModule {}
