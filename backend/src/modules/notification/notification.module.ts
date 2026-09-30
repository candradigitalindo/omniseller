import { type DynamicModule, Global, Module } from "@nestjs/common";
import { createEmailSender, EMAIL_SENDER } from "./email";

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
