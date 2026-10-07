import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TwoFactorKeys } from "../../common/security/two-factor";
import { ENV } from "../../config/config.module";
import { IdentityModule } from "../identity/identity.module";
import { AuthController } from "./auth.controller";
import { AuthGuard, PermissionGuard } from "./auth.guard";
import { AuthRepository } from "./auth.repository";
import { AuthService } from "./auth.service";
import { SessionsController, TwoFactorController } from "./two-factor.controller";
import { TWO_FACTOR_KEYS, TwoFactorService } from "./two-factor.service";
import { UserSessionsService } from "./user-sessions.service";

/** Services of the auth module; loaded by api and worker (the worker sends reset emails). */
@Module({
  imports: [IdentityModule],
  providers: [AuthRepository, AuthService],
  exports: [AuthService],
})
export class AuthModule {}

/**
 * HTTP side, api process only: the controllers, two-step verification (it holds the TOTP key, which no
 * other process gets), and the two global guards. Guards run in registration order: authentication
 * first, then permissions (backend doc 8.1).
 */
@Module({
  imports: [AuthModule, IdentityModule],
  controllers: [AuthController, TwoFactorController, SessionsController],
  providers: [
    {
      provide: TWO_FACTOR_KEYS,
      inject: [ENV],
      useFactory: (env: { TOTP_ENCRYPTION_KEY: string }) => new TwoFactorKeys(env.TOTP_ENCRYPTION_KEY),
    },
    TwoFactorService,
    UserSessionsService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AuthHttpModule {}
