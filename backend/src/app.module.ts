import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule, type Provider } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ZodSerializerInterceptor } from "nestjs-zod";
import { RequestIdMiddleware } from "./common/context/request-id.middleware";
import { ProblemDetailsFilter } from "./common/errors/problem-details.filter";
import { AppValidationPipe } from "./common/http/validation";
import { ConfigModule } from "./config/config.module";
import type { Env } from "./config/env.schema";
import { InfraModule } from "./infra/infra.module";
import { AuditHttpModule } from "./modules/audit/audit.module";
import { AuthHttpModule, AuthModule } from "./modules/auth/auth.module";
import { IdentityHttpModule } from "./modules/identity/identity.http.module";
import { IdentityModule } from "./modules/identity/identity.module";
import { NotificationModule } from "./modules/notification/notification.module";
import { HealthController } from "./modules/platform/health.controller";
import { SchedulerRunner } from "./scheduler/scheduler.runner";
import { WorkerRunner } from "./worker/worker.runner";

@Module({})
class HttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}

/** HTTP pipeline shared by api and webhook (backend doc 8.1): validation, response schemas, Problem Details. */
const HTTP_PROVIDERS: Provider[] = [
  { provide: APP_PIPE, useClass: AppValidationPipe },
  { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  { provide: APP_FILTER, useClass: ProblemDetailsFilter },
];

/**
 * One image, five process roles (backend doc 3.1). The role decides which modules load:
 * api       HTTP API: auth, identity, audit (more modules join as they are built)
 * webhook   HTTP webhook receiver only (verify, store, enqueue, reply)
 * worker    BullMQ processors and the services their handlers call
 * scheduler outbox relay, stock flush, partitions, periodic jobs
 * research-collector research module only
 */
@Module({})
export class AppModule {
  static forEnv(env: Env): DynamicModule {
    const imports = [ConfigModule.forEnv(env), InfraModule.forEnv(env)];
    switch (env.APP_ROLE) {
      case "api":
        return {
          module: AppModule,
          imports: [
            ...imports,
            { module: HttpModule, controllers: [HealthController] },
            AuthHttpModule,
            IdentityHttpModule,
            AuditHttpModule,
          ],
          providers: HTTP_PROVIDERS,
        };
      case "webhook":
        return {
          module: AppModule,
          imports: [...imports, { module: HttpModule, controllers: [HealthController] }],
          providers: HTTP_PROVIDERS,
        };
      case "worker":
        return {
          module: AppModule,
          imports: [...imports, NotificationModule.forWorker(env), IdentityModule, AuthModule],
          providers: [WorkerRunner],
        };
      case "scheduler":
        return { module: AppModule, imports, providers: [SchedulerRunner] };
      case "research-collector":
        return { module: AppModule, imports };
    }
  }
}
