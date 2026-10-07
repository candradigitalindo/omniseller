import type { BusinessDocument, BusinessProfile } from "./business-meta";

/** A business profile as the api returns it (backend doc 8.29). */
export const PROFILE: BusinessProfile = {
  rowVersion: 3,
  name: "Toko Rina",
  timezone: "Asia/Jakarta",
  currency: "IDR",
  address: { line1: "Jl. Melati No. 5", city: "Kota Bandung", province: "Jawa Barat", postalCode: "40132" },
  phone: "081234567890",
  hasLogo: false,
  nib: null,
  nibInProcessSince: null,
  nibStatus: "missing",
  nibDeadline: null,
  nibDaysLeft: null,
  npwp: "123456789012000",
  pkp: false,
  documents: [],
  today: "2026-10-07",
};

export function doc(over: Partial<BusinessDocument> = {}): BusinessDocument {
  return {
    id: "01JDOC0000000000000000001",
    kind: "nib",
    title: "NIB",
    number: "1234567890123",
    issuedOn: "2024-01-10",
    validUntil: null,
    status: "no_expiry",
    daysLeft: null,
    fileName: "nib.pdf",
    createdAt: "2026-10-01T03:00:00.000Z",
    ...over,
  };
}
