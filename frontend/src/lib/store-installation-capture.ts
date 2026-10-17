import { type NextRequest, NextResponse } from "next/server";
import { createApi } from "./api/client";

export const INSTALLATION_PATH = "/integrasi/instalasi/tiktokshop";
const CALLBACK_PATH = "/integrasi/callback/tiktokshop";

/** App Store installation is the documented seller redirect without an app-generated OAuth state. */
export function isAppStoreRedirect(url: URL): boolean {
  return url.pathname === CALLBACK_PATH && !url.searchParams.get("state") && url.searchParams.has("code");
}

/** Runs on the web server before login: no code reaches login URLs, React, or browser storage. */
export async function captureAppStoreInstallation(request: NextRequest): Promise<NextResponse> {
  const destination = new URL(INSTALLATION_PATH, request.url);
  const code = request.nextUrl.searchParams.get("code")?.trim();
  let cookie: string | undefined;
  if (code && code.length <= 512 && code !== "null" && request.nextUrl.searchParams.getAll("code").length === 1) {
    try {
      const serverApi = createApi({ baseUrl: process.env.API_ORIGIN ?? "http://localhost:3000" });
      const captured = await serverApi.POST("/v1/store-installations/tiktokshop/capture", {
        body: { code },
        headers: {
          Origin: request.nextUrl.origin,
          ...(request.headers.get("cf-connecting-ip")
            ? { "CF-Connecting-IP": request.headers.get("cf-connecting-ip")! }
            : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (captured.response.ok) {
        cookie = captured.response.headers.getSetCookie().find((value) => value.startsWith("os_tiktok_install="));
      }
    } catch {
      // Provider codes and transport errors can contain private information: return a fixed status only.
    }
  }
  if (!cookie) destination.searchParams.set("capture", "failed");
  const response = NextResponse.redirect(destination, 303);
  if (cookie) response.headers.append("Set-Cookie", cookie);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
