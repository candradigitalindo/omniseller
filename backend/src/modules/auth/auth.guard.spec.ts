import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { WHILE_CLOSING_KEY } from "../../common/http/decorators";
import type { SessionStore } from "../../common/security/session-store";
import type { DevicesService } from "../identity/devices.service";
import type { UsersService } from "../identity/users.service";
import { AuthGuard } from "./auth.guard";

const TOKEN = "a".repeat(43);

/** The guard over one request: a session of a user of a business in `status`, holding `permissions`. */
function guard(status: "active" | "closing" | "closed", permissions: string[], whileClosing = false) {
  const handler = () => undefined;
  const reflector = new Reflector();
  if (whileClosing) Reflect.defineMetadata(WHILE_CLOSING_KEY, true, handler);
  const users = {
    loadPrincipal: async () => ({
      user: { id: "U1", status: "active", locale: "id" },
      tenant: { id: "T1", status },
      permissions,
      storeScope: null,
      warehouseScope: null,
    }),
  } as unknown as UsersService;
  const sessions = {
    get: async () => ({ tenantId: "T1", userId: "U1" }),
    revoke: async () => undefined,
  } as unknown as SessionStore;
  const limiter = { take: async () => ({ allowed: true, remaining: 599, retryAfterSeconds: 0 }) };
  const g = new AuthGuard(reflector, sessions, users, limiter as never, {} as DevicesService);
  const run = (method: string) => {
    const req = { method, headers: { cookie: `os_session=${TOKEN}` } };
    const res = { setHeader: () => undefined, getHeader: () => undefined };
    const context = {
      getType: () => "http",
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    return g.canActivate(context);
  };
  return run;
}

describe("AuthGuard and an account closing (backend doc 8.36)", () => {
  it("lets who manages billing read, and write only where a route allows it", async () => {
    await expect(guard("closing", ["settings:billing"])("GET")).resolves.toBe(true);
    await expect(guard("closing", ["settings:billing"])("POST")).rejects.toMatchObject({ code: "tenant.read_only" });
    await expect(guard("closing", ["settings:billing"], true)("DELETE")).resolves.toBe(true);
  });

  it("keeps everyone else out, even to read", async () => {
    await expect(guard("closing", ["order:read", "data:export"])("GET")).rejects.toMatchObject({
      code: "tenant.closing",
    });
  });

  it("lets nobody into a closed business, and anyone into an active one", async () => {
    await expect(guard("closed", ["settings:billing"])("GET")).rejects.toMatchObject({ code: "tenant.inactive" });
    await expect(guard("active", [])("POST")).resolves.toBe(true);
  });
});
