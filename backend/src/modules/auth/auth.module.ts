import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { IdentityModule } from "../identity/identity.module";
import { AuthController } from "./auth.controller";
import { AuthGuard, PermissionGuard } from "./auth.guard";
import { AuthRepository } from "./auth.repository";
import { AuthService } from "./auth.service";

/** Services of the auth module; loaded by api and worker (the worker sends reset emails). */
@Module({
  imports: [IdentityModule],
  providers: [AuthRepository, AuthService],
  exports: [AuthService],
})
export class AuthModule {}

/**
 * HTTP side, api process only: the controller and the two global guards. Guards run in
 * registration order: authentication first, then permissions (backend doc 8.1).
 */
@Module({
  imports: [AuthModule, IdentityModule],
  controllers: [AuthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AuthHttpModule {}
