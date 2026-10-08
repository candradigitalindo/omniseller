/**
 * An address on the public site (`website/`, technology doc ADR-041), where the terms and policies live,
 * from NEXT_PUBLIC_SITE_URL at build time. Null where there is none (local, CI): the app then names the
 * documents without linking them.
 */
export function siteUrl(path: string): string | null {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
}
