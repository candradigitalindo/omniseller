/** Two-step verification and signed-in devices on Akun saya (UI L41b, backend doc 8.30). */

export const twoFactorQueryKey = ["me", "two-factor"] as const;
export const sessionsQueryKey = ["me", "sessions"] as const;

/** Few enough backup codes left that it is time to make new ones. */
export const LOW_BACKUP_CODES = 3;

/** The QR code the api draws, as an image source: no markup from the network enters the page. */
export function qrDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A base32 secret in groups of four, as people type it into an app. */
export function groupSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

/** The backup codes as a text file to keep. */
export function backupCodesText(codes: string[], title: string, note: string): string {
  return [title, "", ...codes, "", note, ""].join("\n");
}

/** "Chrome di macOS", or whatever part is known. */
export function deviceName(
  s: { browser: string | null; os: string | null },
  named: (browser: string, os: string) => string,
  unknown: string,
): string {
  if (s.browser && s.os) return named(s.browser, s.os);
  return s.browser ?? s.os ?? unknown;
}

/** A phone or a computer, for the device's icon. */
export function isPhone(os: string | null): boolean {
  return os === "iOS" || os === "Android";
}
