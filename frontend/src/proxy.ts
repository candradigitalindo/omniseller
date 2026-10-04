import { type NextRequest, NextResponse } from "next/server";

/** The session cookie the api sets on login (backend doc 8.10). */
export const SESSION_COOKIE = "os_session";

/** Pages anyone may open: signing in and the links in emails and marketplace redirects. */
const PUBLIC_PATHS = ["/masuk", "/daftar", "/lupa-sandi", "/atur-ulang-sandi", "/undangan"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * An optimistic check only: without a session cookie a page of the app sends the visitor to sign in,
 * coming back afterwards. Whether the session is still valid is the api's call; any 401 it answers sends
 * the browser to `/masuk` as well (lib/api/client.ts).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname) || request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const login = new URL("/masuk", request.url);
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // not the api (`/v1`, rewritten to it), Next.js assets, or files with an extension
  matcher: ["/((?!v1/|_next/|.*\\..*).*)"],
};
