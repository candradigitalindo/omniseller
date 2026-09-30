import type { Request } from "express";
import type { RequestContext } from "../context/request-context";

export const SESSION_COOKIE = "os_session";

/** Minimal Cookie header parser: first value wins, values are URI-decoded. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Client IP. In production only Cloudflare reaches the ALB (technology doc 19.1), so
 * CF-Connecting-IP is trustworthy; locally it is absent and the socket address is used.
 */
export function clientIp(req: Request): string {
  const cf = req.header("cf-connecting-ip");
  if (cf && /^[0-9a-fA-F:.]{3,45}$/.test(cf)) return cf;
  return req.socket.remoteAddress ?? "unknown";
}

/** Request augmented by the auth guard. */
export interface AuthedRequest extends Request {
  ctx?: RequestContext;
  sessionToken?: string;
}
