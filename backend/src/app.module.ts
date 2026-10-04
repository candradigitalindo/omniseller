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
import { CatalogHttpModule, CatalogModule, CatalogWorkerModule } from "./modules/catalog/catalog.module";
import {
  ChannelHttpModule,
  ChannelModule,
  ChannelWorkerModule,
  ConnectorsModule,
} from "./modules/channel/channel.module";
import { ExportsHttpModule, ExportsWorkerModule } from "./modules/exports/exports.module";
import { FilesHttpModule, FilesModule } from "./modules/files/files.module";
import {
  FulfillmentHttpModule,
  FulfillmentModule,
  FulfillmentWorkerModule,
} from "./modules/fulfillment/fulfillment.module";
import { IdentityHttpModule } from "./modules/identity/identity.http.module";
import { IdentityModule } from "./modules/identity/identity.module";
import { InventoryHttpModule, InventoryModule, InventoryWorkerModule } from "./modules/inventory/inventory.module";
import { MigrationHttpModule, MigrationWorkerModule } from "./modules/migration/migration.module";
import { NotificationHttpModule, NotificationModule } from "./modules/notification/notification.module";
import { OrdersHttpModule, OrdersModule, OrdersWorkerModule } from "./modules/orders/orders.module";
import { HealthController } from "./modules/platform/health.controller";
import { ReportingHttpModule } from "./modules/reporting/reporting.module";
import { SyncModule, WebhookHttpModule } from "./modules/sync/sync.module";
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
 * api       HTTP API: auth, identity, audit, stores, warehouses, stock, catalog, orders, shipping, files,
 *           notifications (more join as they are built)
 * webhook   HTTP webhook receiver only (verify, store, enqueue, reply)
 * worker    BullMQ processors and the services their handlers call
 * scheduler outbox relay, stock flush, partitions, periodic jobs
 * research-collector research module only
 */
@Module({})
export class AppModule {
  /**
   * Test hooks: `fetch` points connectors at a fake marketplace without a network, `queuePrefix`
   * keeps a test run's BullMQ keys apart from any other user of the same Redis.
   */
  static forEnv(env: Env, opts: { fetch?: typeof fetch; queuePrefix?: string } = {}): DynamicModule {
    const imports = [ConfigModule.forEnv(env), InfraModule.forEnv(env, opts)];
    const fetchImpl = opts.fetch;
    switch (env.APP_ROLE) {
      case "api":
        return {
          module: AppModule,
          imports: [
            ...imports,
            { module: HttpModule, controllers: [HealthController] },
            ConnectorsModule.forEnv(env, fetchImpl),
            AuthHttpModule,
            IdentityHttpModule,
            AuditHttpModule,
            InventoryHttpModule,
            ChannelHttpModule,
            CatalogHttpModule,
            OrdersHttpModule,
            FilesModule.forEnv(env),
            FilesHttpModule,
            FulfillmentHttpModule,
            NotificationHttpModule,
            ReportingHttpModule,
            ExportsHttpModule,
            MigrationHttpModule,
          ],
          providers: HTTP_PROVIDERS,
        };
      case "webhook":
        return {
          module: AppModule,
          imports: [
            ...imports,
            { module: HttpModule, controllers: [HealthController] },
            ConnectorsModule.forEnv(env, fetchImpl),
            WebhookHttpModule,
          ],
          providers: HTTP_PROVIDERS,
        };
      case "worker":
        return {
          module: AppModule,
          imports: [
            ...imports,
            ConnectorsModule.forEnv(env, fetchImpl),
            NotificationModule.forWorker(env),
            IdentityModule,
            AuthModule,
            InventoryModule,
            SyncModule,
            ChannelModule,
            ChannelWorkerModule.forEnv(env),
            CatalogModule,
            CatalogWorkerModule,
            InventoryWorkerModule,
            OrdersModule,
            OrdersWorkerModule,
            FilesModule.forEnv(env),
            FulfillmentModule,
            FulfillmentWorkerModule,
            ExportsWorkerModule,
            MigrationWorkerModule,
          ],
          providers: [WorkerRunner],
        };
      case "scheduler":
        return { module: AppModule, imports, providers: [SchedulerRunner] };
      case "research-collector":
        return { module: AppModule, imports };
    }
  }
}
