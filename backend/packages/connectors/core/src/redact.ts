/**
 * Redaction for connector call summaries (technology doc 8.2: responses are kept for debugging with
 * buyer data masked). Secrets and personal data are replaced by "[redacted]" wherever the key appears.
 */
const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "code",
  "auth_code",
  "app_secret",
  "partner_key",
  "sign",
  "authorization",
  "x-tts-access-token",
]);

const PERSONAL_KEYS = new Set([
  "recipient_address",
  "buyer_username",
  "buyer_email",
  "buyer_message",
  "phone",
  "phone_number",
  "contact_person",
  "first_name",
  "last_name",
  "first_name_local_script",
  "last_name_local_script",
  "email",
]);

export const REDACTED = "[redacted]";

function sensitive(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEYS.has(k) || PERSONAL_KEYS.has(k);
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sensitive(k) ? REDACTED : redactValue(v, depth + 1);
    return out;
  }
  return value;
}

/** Path plus query with secret parameter values masked; the host is dropped. */
export function redactUrl(url: URL): string {
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) params.append(k, sensitive(k) ? REDACTED : v);
  const q = params.toString();
  return q ? `${url.pathname}?${q}` : url.pathname;
}

/** A JSON value cut to a size that fits a log row. */
export function summarize(value: unknown, maxChars = 4000): unknown {
  const redacted = redactValue(value);
  const text = JSON.stringify(redacted);
  if (text === undefined || text.length <= maxChars) return redacted;
  return { truncated: true, preview: text.slice(0, maxChars) };
}
