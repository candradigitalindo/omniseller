import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import { ApiExtension } from "@nestjs/swagger";
import type { Permission } from "@omniseller/shared";
import type { RequestContext } from "../context/request-context";
import { InternalError } from "../errors/domain-errors";
import type { AuthedRequest } from "./request";

export const PUBLIC_KEY = "omniseller:public";
export const PERMISSION_KEY = "omniseller:permission";

/**
 * Tenant isolation contract (backend doc 13.3). Every operation declares how it relates to tenants,
 * and the isolation test generator reads it from openapi.json:
 *  - "public":  no session (signup, login, health)
 *  - "self":    acts only on the caller's own user or session (me, logout)
 *  - "global":  returns global reference data, identical for every tenant (permission catalogue)
 *  - fixture:   operates on tenant resources of that kind; the generator creates one in tenant A and
 *               calls the operation as tenant B, expecting 404 (or absence from a list)
 */
export type IsolationKind = "public" | "self" | "global" | { fixture: string };

export function Isolation(kind: IsolationKind): MethodDecorator & ClassDecorator {
  return ApiExtension("x-isolation", kind) as MethodDecorator & ClassDecorator;
}

/** No session required. Implies Isolation("public"). */
export function Public(): MethodDecorator {
  return (target, key, descriptor) => {
    SetMetadata(PUBLIC_KEY, true)(target, key, descriptor);
    Isolation("public")(target, key, descriptor);
  };
}

/** Permission checked by PermissionGuard after authentication (backend doc 10.5). */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

/** The RequestContext built by the auth guard. */
export const Ctx = createParamDecorator((_data: unknown, host: ExecutionContext): RequestContext => {
  const req = host.switchToHttp().getRequest<AuthedRequest>();
  if (!req.ctx) throw new InternalError("internal.no_context", "route is public but asked for a context");
  return req.ctx;
});
