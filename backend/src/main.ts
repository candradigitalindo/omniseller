import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule } from "@nestjs/swagger";
import { configureLogger, logger, setLogContextProvider } from "@omniseller/logging";
import { AppModule } from "./app.module";
import { logFields } from "./common/context/request-context";
import { NestPinoLogger } from "./common/logging/nest-logger";
import { parseEnv } from "./config/env.schema";
import { buildOpenApiDocument } from "./openapi/document";

/** Entry point for every process role; APP_ROLE picks the modules (backend doc 3.1). */
async function bootstrap(): Promise<void> {
  const env = parseEnv(process.env);
  configureLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === "local", base: { role: env.APP_ROLE } });
  setLogContextProvider(logFields);
  const log = logger.forModule("main");

  if (env.APP_ROLE === "api" || env.APP_ROLE === "webhook") {
    const app = await NestFactory.create(AppModule.forEnv(env), { logger: new NestPinoLogger(), bodyParser: true });
    app.enableShutdownHooks();
    if (env.APP_ROLE === "api") {
      // The web app calls the API cross-origin with the session cookie (technology doc 5.3).
      app.enableCors({ origin: env.PUBLIC_WEB_URL, credentials: true, exposedHeaders: ["ETag", "X-Request-Id"] });
      if (env.NODE_ENV !== "production") SwaggerModule.setup("docs", app, buildOpenApiDocument(app));
    }
    await app.listen(env.PORT);
    log.info({ port: env.PORT }, `${env.APP_ROLE} listening`);
  } else {
    const app = await NestFactory.createApplicationContext(AppModule.forEnv(env), { logger: new NestPinoLogger() });
    app.enableShutdownHooks();
    log.info(`${env.APP_ROLE} started`);
  }
}

bootstrap().catch((err) => {
  // Before the logger is configured the only safe sink is stderr.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
