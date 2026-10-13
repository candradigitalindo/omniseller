/**
 * Numbers, money, and times as DOKUMEN-UI-UX section 5 writes them: `Rp 1.250.000` (a space after Rp,
 * dots for thousands, no decimals), `30 Sep 2026, 14.05` in the business's time zone, and "5 menit lalu"
 * for what just happened.
 */

const integer = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

export function formatNumber(value: number): string {
  return integer.format(value);
}

export function formatRupiah(value: number): string {
  return value < 0 ? `-Rp ${integer.format(-value)}` : `Rp ${integer.format(value)}`;
}

/** A change in percent with its sign: `+12%`, `-3,5%`; one decimal below 10. */
export function formatPercentChange(pct: number): string {
  const abs = Math.abs(pct);
  const text = new Intl.NumberFormat("id-ID", { maximumFractionDigits: abs < 10 ? 1 : 0 }).format(abs);
  return `${pct > 0 ? "+" : pct < 0 ? "-" : ""}${text}%`;
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormat(timeZone: string, kind: "datetime" | "date" | "time" | "dayMonth"): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone}`;
  let f = dateTimeFormats.get(key);
  if (!f) {
    const options: Intl.DateTimeFormatOptions =
      kind === "datetime"
        ? { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
        : kind === "date"
          ? { day: "numeric", month: "short", year: "numeric" }
          : kind === "time"
            ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
            : { day: "numeric", month: "short" };
    f = new Intl.DateTimeFormat("id-ID", { ...options, timeZone });
    dateTimeFormats.set(key, f);
  }
  return f;
}

const toDate = (value: string | Date) => (typeof value === "string" ? new Date(value) : value);

/** `30 Sep 2026, 14.05` */
export function formatDateTime(value: string | Date, timeZone: string): string {
  return dateTimeFormat(timeZone, "datetime").format(toDate(value));
}

/** The zone as Indonesians write it: WIB, WITA, WIT; other zones by name. */
export function zoneAbbreviation(timeZone: string): string {
  return { "Asia/Jakarta": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT" }[timeZone] ?? timeZone;
}

/** `30 Sep 2026` */
export function formatDate(value: string | Date, timeZone: string): string {
  return dateTimeFormat(timeZone, "date").format(toDate(value));
}

/** `30 Sep` */
export function formatDayMonth(value: string | Date, timeZone: string): string {
  return dateTimeFormat(timeZone, "dayMonth").format(toDate(value));
}

/** `14.05` */
export function formatTime(value: string | Date, timeZone: string): string {
  return dateTimeFormat(timeZone, "time").format(toDate(value));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "baru saja", "5 menit lalu", "3 jam lalu", "kemarin"; older than a week: the date and time. */
export function formatRelative(value: string | Date, timeZone: string, now: Date = new Date()): string {
  const at = toDate(value);
  const ago = now.getTime() - at.getTime();
  if (ago < 0) return formatDateTime(at, timeZone);
  if (ago < MINUTE) return "baru saja";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} menit lalu`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} jam lalu`;
  if (ago < 2 * DAY) return "kemarin";
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)} hari lalu`;
  return formatDateTime(at, timeZone);
}

/**
 * Time left before a deadline, as the ship-by countdown shows it (8.6): "2 jam 15 menit lagi",
 * "45 menit lagi", "lewat 1 jam 5 menit".
 */
export function formatRemaining(ms: number): string {
  const late = ms < 0;
  const total = Math.floor(Math.abs(ms) / MINUTE);
  const days = Math.floor(total / (24 * 60));
  const hours = Math.floor((total % (24 * 60)) / 60);
  const minutes = total % 60;
  const parts =
    days > 0
      ? [`${days} hari`, hours > 0 ? `${hours} jam` : ""]
      : hours > 0
        ? [`${hours} jam`, minutes > 0 ? `${minutes} menit` : ""]
        : [`${minutes} menit`];
  const text = parts.filter(Boolean).join(" ");
  return late ? `lewat ${text}` : `${text} lagi`;
}

/** First name for the greeting: "Selamat pagi, Rina". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Morning, afternoon, evening, or night in the business's time zone. */
export function greeting(timeZone: string, now: Date = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(now));
  if (hour >= 4 && hour < 11) return "Selamat pagi";
  if (hour >= 11 && hour < 15) return "Selamat siang";
  if (hour >= 15 && hour < 18) return "Selamat sore";
  return "Selamat malam";
}
