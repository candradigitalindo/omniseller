export type TemporalType = "date" | "time" | "datetime-local";

export function moneyText(value: string): string {
  return /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".") : value;
}
export function parseMoneyText(value: string): string | null {
  const text = value.replace(/^\s*Rp\s*/i, "").trim();
  if (!text) return "";
  return /^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(text) ? text.replaceAll(".", "").replace(/^0+(?=\d)/, "") : null;
}
export function temporalText(value: string, type: TemporalType): string {
  if (!value) return "";
  if (type === "time") return value.replace(":", ".");
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  return match
    ? `${match[3]}/${match[2]}/${match[1]}${type === "datetime-local" && match[4] ? ` ${match[4]}.${match[5]}` : ""}`
    : value;
}
export function parseTemporalText(value: string, type: TemporalType): string | null {
  const text = value.trim();
  if (!text) return "";
  if (type === "time") {
    const match = /^(\d{2})[.:,]?(\d{2})$/.exec(text);
    return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? `${match[1]}:${match[2]}` : null;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(text);
  const local = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2})[.:](\d{2}))?$/.exec(text);
  if (!iso && !local) return null;
  const year = iso?.[1] ?? local?.[3];
  const month = iso?.[2] ?? local?.[2];
  const day = iso?.[3] ?? local?.[1];
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  if (type === "date") return date;
  const time = parseTemporalText(`${iso?.[4] ?? local?.[4] ?? ""}:${iso?.[5] ?? local?.[5] ?? ""}`, "time");
  return time ? `${date}T${time}` : null;
}
