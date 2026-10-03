import { type DynamicModule, Global, Module } from "@nestjs/common";
import { createEmailSender, EMAIL_SENDER } from "./email";
import { NotificationsController } from "./inbox.controller";
import { InboxRepository } from "./inbox.repository";
import { NotificationInboxService } from "./inbox.service";

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
@Module({ providers: [InboxRepository, NotificationInboxService], exports: [NotificationInboxService] })
export class NotificationInboxModule {}

@Module({ imports: [NotificationInboxModule], controllers: [NotificationsController] })
export class NotificationHttpModule {}
