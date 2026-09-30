import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { Env } from "./env.schema";

/** Injection token for the validated environment. The only place process.env is read is main.ts. */
export const ENV = Symbol("ENV");

@Global()
@Module({})
export class ConfigModule {
  static forEnv(env: Env): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: ENV, useValue: Object.freeze({ ...env }) }],
      exports: [ENV],
    };
  }
}
