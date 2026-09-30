import type { Response } from "express";
import { SESSION_COOKIE } from "../../common/http/request";
import { SESSION_TTL_SECONDS } from "../../common/security/session-store";

/**
 * Session cookie (technology doc 5.3): HttpOnly, SameSite=Lax (cross-site POSTs carry no cookie,
 * which is the CSRF defence together with JSON-only bodies), Secure outside local and test.
 * Host-only: the web app calls the API with credentials: "include".
 */
export function setSessionCookie(res: Response, token: string, nodeEnv: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: nodeEnv !== "local" && nodeEnv !== "test",
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearSessionCookie(res: Response, nodeEnv: string): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: nodeEnv !== "local" && nodeEnv !== "test",
    path: "/",
  });
}
