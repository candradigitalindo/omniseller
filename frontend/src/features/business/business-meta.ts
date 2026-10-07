import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type BusinessProfile = components["schemas"]["BusinessProfileDto_Output"];
export type BusinessDocument = BusinessProfile["documents"][number];
export type DocumentKind = BusinessDocument["kind"];
type ProfilePatch = components["schemas"]["UpdateBusinessProfileDto"];

/** Indonesia's three zones (backend `BUSINESS_TIMEZONES`), by their everyday names. */
export const TIMEZONES = [
  { value: "Asia/Jakarta", key: "wib" },
  { value: "Asia/Makassar", key: "wita" },
  { value: "Asia/Jayapura", key: "wit" },
] as const;

export const DOCUMENT_KINDS = [
  "nib",
  "npwp",
  "sppkp",
  "deed",
  "business_license",
  "other",
] as const satisfies readonly DocumentKind[];

/** Whether the business has an NIB, is getting one (six months at most), or has none yet. */
export type NibMode = "registered" | "in_process" | "missing";

export interface ProfileDraft {
  name: string;
  timezone: string;
  line1: string;
  district: string;
  city: string;
  province: string;
  postalCode: string;
  phone: string;
  nibMode: NibMode;
  nib: string;
  nibInProcessSince: string;
  npwp: string;
  pkp: boolean;
}

export function draftOf(p: BusinessProfile): ProfileDraft {
  return {
    name: p.name,
    timezone: p.timezone,
    line1: p.address.line1 ?? "",
    district: p.address.district ?? "",
    city: p.address.city ?? "",
    province: p.address.province ?? "",
    postalCode: p.address.postalCode ?? "",
    phone: p.phone ?? "",
    nibMode: p.nibStatus,
    nib: p.nib ?? "",
    nibInProcessSince: p.nibInProcessSince ?? "",
    npwp: p.npwp ? formatNpwp(p.npwp) : "",
    pkp: p.pkp,
  };
}

/** Digits only, as numbers are typed with dots, dashes, and spaces. */
export const digitsOf = (text: string) => text.replace(/[\s.\-/]/g, "");

/** The old 15-digit NPWP as printed on the card (12.345.678.9-012.000); the 16-digit one as it is. */
export function formatNpwp(digits: string): string {
  const d = digitsOf(digits);
  if (d.length !== 15) return d;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}.${d.slice(8, 9)}-${d.slice(9, 12)}.${d.slice(12)}`;
}

export type ProfileField = "name" | "postalCode" | "phone" | "nib" | "nibInProcessSince" | "npwp";
export type ProfileProblem =
  | "nameLength"
  | "postalCode"
  | "phone"
  | "nibDigits"
  | "sinceRequired"
  | "sinceFuture"
  | "npwpDigits";

/** What stops the draft from being saved, per field; checked again by the api. */
export function problemsOf(d: ProfileDraft, today: string): Partial<Record<ProfileField, ProfileProblem>> {
  const out: Partial<Record<ProfileField, ProfileProblem>> = {};
  const name = d.name.trim();
  if (name.length < 2 || name.length > 80) out.name = "nameLength";
  if (d.postalCode.trim() && !/^[0-9]{5}$/.test(d.postalCode.trim())) out.postalCode = "postalCode";
  if (d.phone.trim() && !/^\+?[0-9]{8,15}$/.test(digitsOf(d.phone))) out.phone = "phone";
  if (d.nibMode === "registered" && !/^[0-9]{13}$/.test(digitsOf(d.nib))) out.nib = "nibDigits";
  if (d.nibMode === "in_process") {
    if (!d.nibInProcessSince) out.nibInProcessSince = "sinceRequired";
    else if (d.nibInProcessSince > today) out.nibInProcessSince = "sinceFuture";
  }
  if (d.npwp.trim() && !/^[0-9]{15,16}$/.test(digitsOf(d.npwp))) out.npwp = "npwpDigits";
  return out;
}

const orNull = (text: string) => (text.trim() === "" ? null : text.trim());

/** Only what changed, so a save never overwrites what someone else changed elsewhere in the profile. */
export function patchOf(d: ProfileDraft, p: BusinessProfile): ProfilePatch {
  const patch: ProfilePatch = {};
  if (d.name.trim() !== p.name) patch.name = d.name.trim();
  if (d.timezone !== p.timezone) patch.timezone = d.timezone as ProfilePatch["timezone"];
  const address = {
    line1: orNull(d.line1),
    district: orNull(d.district),
    city: orNull(d.city),
    province: orNull(d.province),
    postalCode: orNull(d.postalCode),
  };
  const before = p.address as Record<string, string | undefined>;
  if (Object.entries(address).some(([k, v]) => (v ?? undefined) !== (before[k] ?? undefined))) {
    patch.address = Object.fromEntries(
      Object.entries(address).filter(([, v]) => v !== null),
    ) as ProfilePatch["address"];
  }
  const phone = orNull(d.phone);
  if ((phone ? digitsOf(phone) : null) !== p.phone) patch.phone = phone;
  const nib = d.nibMode === "registered" ? digitsOf(d.nib) : null;
  const since = d.nibMode === "in_process" ? d.nibInProcessSince : null;
  if (nib !== p.nib || since !== p.nibInProcessSince) {
    patch.nib = nib;
    patch.nibInProcessSince = since;
  }
  const npwp = orNull(d.npwp);
  if ((npwp ? digitsOf(npwp) : null) !== p.npwp) patch.npwp = npwp;
  if (d.pkp !== p.pkp) patch.pkp = d.pkp;
  return patch;
}

/** How a document's validity reads: a tone and the message key with its values. */
export function documentBadge(d: Pick<BusinessDocument, "status" | "daysLeft" | "validUntil">): {
  tone: Tone;
  key: "noExpiry" | "validUntil" | "expiresIn" | "expiresToday" | "expiredOn";
} {
  switch (d.status) {
    case "no_expiry":
      return { tone: "neutral", key: "noExpiry" };
    case "valid":
      return { tone: "success", key: "validUntil" };
    case "expiring":
      return { tone: "warning", key: d.daysLeft === 0 ? "expiresToday" : "expiresIn" };
    case "expired":
      return { tone: "danger", key: "expiredOn" };
  }
}

/** Files the api takes for legal documents, and for the logo. */
export const DOCUMENT_TYPES = "application/pdf,image/png,image/jpeg";
export const LOGO_TYPES = "image/png,image/jpeg,image/webp";
export const MAX_DOCUMENT_BYTES = 5_000_000;
export const MAX_LOGO_BYTES = 1_000_000;
