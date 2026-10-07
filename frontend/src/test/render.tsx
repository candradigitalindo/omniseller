import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type Me, type Permission, SessionProvider } from "@/lib/session";
import messages from "../../messages/id.json";

export const ALL_PERMISSIONS: Permission[] = [
  "order:read",
  "order:accept",
  "order:cancel",
  "order:tag",
  "order:write",
  "shipment:arrange",
  "shipment:print",
  "shipment:pack",
  "shipment:handover",
  "return:respond",
  "return:receive",
  "inventory:read",
  "inventory:adjust",
  "inventory:count",
  "inventory:transfer",
  "catalog:read",
  "catalog:write",
  "catalog:map",
  "catalog:publish",
  "finance:read",
  "report:read",
  "settings:store",
  "settings:warehouse",
  "settings:user",
  "data:export",
  "audit:read",
  "settings:billing",
];

export function testMe(permissions: Permission[] = ALL_PERMISSIONS): Me {
  return {
    user: {
      id: "01JUSER0000000000000000000",
      name: "Rina Wulandari",
      email: "rina@example.test",
      locale: "id",
      twoFactorEnabled: false,
    },
    tenant: {
      id: "01JTENANT00000000000000000",
      name: "Toko Rina",
      slug: "toko-rina",
      timezone: "Asia/Jakarta",
      status: "active",
    },
    permissions,
    roles: [{ id: "01JROLE0000000000000000000", name: "Pemilik" }],
    storeScope: null,
    warehouseScope: null,
  };
}

/** A screen inside the providers the app shell gives it: messages, queries, the session, tooltips, toasts. */
export function renderApp(ui: ReactNode, { me = testMe() }: { me?: Me } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="id" messages={messages} timeZone="Asia/Jakarta">
      <QueryClientProvider client={queryClient}>
        <SessionProvider me={me}>
          <TooltipProvider>
            {ui}
            <Toaster />
          </TooltipProvider>
        </SessionProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

export type ApiCall = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers?: Record<string, string>;
};
type Handler = (call: ApiCall) => unknown;

/**
 * Answers the app's api calls from handlers keyed `"GET /v1/orders"`; returns every call made. A handler
 * returns the JSON body, a Response, or undefined for 204. Unknown routes answer 404 Problem Details.
 */
export function mockApi(handlers: Record<string, Handler>): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.text();
      const call: ApiCall = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: text ? JSON.parse(text) : undefined,
        headers: Object.fromEntries(request.headers),
      };
      calls.push(call);
      const handler = handlers[`${request.method} ${url.pathname}`];
      if (!handler) return problem(404, "test.unmocked", `${request.method} ${url.pathname} is not mocked`);
      const result = handler(call);
      if (result instanceof Response) return result;
      if (result === undefined) return new Response(null, { status: 204 });
      return Response.json(result);
    }),
  );
  return calls;
}

export function problem(status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ type: "about:blank", title: detail, status, code, detail, ...extra }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}
