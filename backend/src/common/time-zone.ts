/**
 * Calendar dates and local times in the business's time zone (`tenant.timezone`, Asia/Jakarta unless
 * changed) without a date library: Intl knows the zones, these turn its parts into instants.
 */

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(tz: string, at: Date): Parts {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset of the time zone from UTC at an instant, in milliseconds (Asia/Jakarta: +7 h). */
export function offsetMs(tz: string, at: Date): number {
  const p = partsIn(tz, at);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a local date (YYYY-MM-DD) starts in the time zone. */
export function startOfDate(tz: string, date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  // the offset at the guess decides; a second pass settles days that change offset (daylight saving)
  const first = utcMidnight - offsetMs(tz, new Date(utcMidnight));
  return new Date(utcMidnight - offsetMs(tz, new Date(first)));
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Local calendar date (YYYY-MM-DD) of an instant. */
export function localDate(tz: string, at: Date): string {
  const p = partsIn(tz, at);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** ISO 8601 local time with its offset, to the second: 2026-10-03T14:15:00+07:00. */
export function isoInZone(tz: string, at: Date): string {
  const p = partsIn(tz, at);
  const offset = Math.round(offsetMs(tz, at) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
