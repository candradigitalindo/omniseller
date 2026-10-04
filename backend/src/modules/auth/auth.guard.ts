import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";
import { attachContext, deviceContext, type RequestContext } from "../../common/context/request-context";
import { RateLimitedError } from "../../common/errors/domain-errors";
import { DEVICE_KEY, PERMISSION_KEY, PUBLIC_KEY } from "../../common/http/decorators";
import { type AuthedRequest, readCookie, SESSION_COOKIE } from "../../common/http/request";
import { RATE_RULES, type RateLimiter } from "../../common/security/rate-limiter";
import type { SessionStore } from "../../common/security/session-store";
import { looksLikeSecretToken } from "../../common/security/tokens";
import { RATE_LIMITER, SESSIONS } from "../../infra/tokens";
import { DevicesService } from "../identity/devices.service";
import { UsersService } from "../identity/users.service";
import { authRequired, deviceUnauthorized, permissionDenied, tenantInactive, tenantReadOnly } from "./auth.errors";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `Authorization: Bearer <token>`, or undefined. */
function bearerToken(req: AuthedRequest): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

/**
 * Global guard, backend doc 8.1 steps 3 to 5: session -> identity and permissions -> tenant status
 * -> per-tenant rate limit. Routes marked @Public() skip it. Permissions and scopes are reloaded
 * from the database on every request, so role changes take effect immediately. Routes marked
 * @DeviceRoute() take a device token instead of a session (backend doc 8.24).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SESSIONS) private readonly sessions: SessionStore,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(DevicesService) private readonly devices: DevicesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const deviceKind = this.reflector.getAllAndOverride<string | undefined>(DEVICE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (deviceKind) return this.device(req, res, deviceKind);
    const token = readCookie(req, SESSION_COOKIE);
    if (!looksLikeSecretToken(token)) throw authRequired();
    const session = await this.sessions.get(token);
    if (!session) throw authRequired();

    const principal = await this.users.loadPrincipal(session.tenantId, session.userId);
    if (principal?.user.status !== "active") {
      await this.sessions.revoke(token);
      throw authRequired();
    }
    if (principal.tenant.status === "suspended" || principal.tenant.status === "closed") throw tenantInactive();
    if (principal.tenant.status === "closing" && !READ_METHODS.has(req.method)) throw tenantReadOnly();

    const rate = await this.limiter.take(`api:tenant:${principal.tenant.id}`, RATE_RULES.tenantApi);
    res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
    if (!rate.allowed) throw new RateLimitedError(rate.retryAfterSeconds);

    const requestId = (res.getHeader("X-Request-Id") as string | undefined) ?? "";
    const ctx: RequestContext = {
      requestId,
      traceId: requestId,
      tenantId: principal.tenant.id,
      actor: { type: "user", id: principal.user.id },
      permissions: new Set(principal.permissions),
      storeScope: principal.storeScope ? new Set(principal.storeScope) : null,
      warehouseScope: principal.warehouseScope ? new Set(principal.warehouseScope) : null,
      locale: principal.user.locale,
    };
    req.ctx = ctx;
    req.sessionToken = token;
    attachContext(ctx);
    return true;
  }

  /** A device route: the device token, the business's status, and the same per-tenant rate limit. */
  private async device(req: AuthedRequest, res: Response, kind: string): Promise<boolean> {
    const token = bearerToken(req);
    if (!looksLikeSecretToken(token)) throw deviceUnauthorized();
    const device = await this.devices.authenticate(token);
    if (device?.kind !== kind) throw deviceUnauthorized();
    if (device.tenantStatus === "suspended" || device.tenantStatus === "closed") throw tenantInactive();
    if (device.tenantStatus === "closing" && !READ_METHODS.has(req.method)) throw tenantReadOnly();

    const rate = await this.limiter.take(`api:tenant:${device.tenantId}`, RATE_RULES.tenantApi);
    res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
    if (!rate.allowed) throw new RateLimitedError(rate.retryAfterSeconds);

    const requestId = (res.getHeader("X-Request-Id") as string | undefined) ?? "";
    const ctx = deviceContext(device.tenantId, device.deviceId, { requestId });
    req.ctx = ctx;
    attachContext(ctx);
    return true;
  }
}

/** Backend doc 8.1 step 7: @RequirePermission('module:action') against the session's permissions. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;
    const required = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;
    const ctx = context.switchToHttp().getRequest<AuthedRequest>().ctx;
    if (!ctx) throw authRequired();
    if (!ctx.permissions.has(required)) throw permissionDenied();
    return true;
  }
}
