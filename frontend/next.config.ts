import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

/**
 * The browser calls the API on the web app's own origin (`/v1/...`), so the session cookie `os_session`
 * stays first-party and no CORS is involved (ADR-039). In production the load balancer sends `/v1/*` to
 * the api before Next.js sees it; locally, and wherever nothing does, this rewrite forwards it.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${API_ORIGIN}/v1/:path*` }];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
