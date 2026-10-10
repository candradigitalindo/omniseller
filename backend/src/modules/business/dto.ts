import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
  BUSINESS_TIMEZONES,
  DEFAULT_BUYER_DATA_RETENTION_MONTHS,
  digitsOf,
  MIN_BUYER_DATA_RETENTION_MONTHS,
} from "./business-plan";
import type { BusinessProfileView, DocumentView } from "./business-profile.service";

const date = z.iso.date();
const base64 = z
  .string()
  .min(1)
  .max(7_000_000)
  .regex(/^[A-Za-z0-9+/=\r\n]+$/, "Isi berkas harus base64.");
const numberAs = (pattern: RegExp, message: string) =>
  z.string().max(40).transform(digitsOf).pipe(z.string().regex(pattern, message));

const address = z.object({
  line1: z.string().trim().max(200).optional(),
  district: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  province: z.string().trim().max(80).optional(),
  postalCode: z
    .string()
    .regex(/^[0-9]{5}$/, "Kode pos terdiri dari 5 angka.")
    .optional(),
});

export const DOCUMENT_KINDS = ["nib", "npwp", "sppkp", "deed", "business_license", "other"] as const;

export class UpdateBusinessProfileDto extends createZodDto(
  z.object({
    name: z.string().trim().min(2).max(80).optional().describe("nama bisnis, juga nama di aplikasi"),
    timezone: z.enum(BUSINESS_TIMEZONES).optional().describe("WIB, WITA, atau WIT; menentukan hari di laporan"),
    address: address.optional(),
    phone: numberAs(/^\+?[0-9]{8,15}$/, "Nomor telepon 8 sampai 15 angka.")
      .nullable()
      .optional(),
    nib: numberAs(/^[0-9]{13}$/, "NIB terdiri dari 13 angka.")
      .nullable()
      .optional()
      .describe("Nomor Induk Berusaha; titik dan spasi boleh diketik"),
    nibInProcessSince: date
      .nullable()
      .optional()
      .describe("sejak kapan NIB sedang diurus; paling lama 6 bulan (Permendag 19/2026)"),
    npwp: numberAs(/^[0-9]{15,16}$/, "NPWP terdiri dari 15 atau 16 angka.")
      .nullable()
      .optional(),
    pkp: z.boolean().optional().describe("terdaftar sebagai Pengusaha Kena Pajak"),
    buyerDataRetentionMonths: z
      .number()
      .int()
      .min(MIN_BUYER_DATA_RETENTION_MONTHS, "Paling cepat 3 bulan.")
      .max(DEFAULT_BUYER_DATA_RETENTION_MONTHS, "Paling lama 24 bulan, sesuai kebijakan privasi.")
      .optional()
      .describe("bulan setelah pesanan, data pribadi pembeli dianonimkan (3 sampai 24)"),
  }),
) {}

export class SetLogoDto extends createZodDto(
  z.object({ content: base64.describe("PNG, JPG, atau WebP, base64, paling besar 1 MB") }),
) {}

export class AddBusinessDocumentDto extends createZodDto(
  z.object({
    kind: z.enum(DOCUMENT_KINDS),
    title: z.string().trim().max(120).optional().describe("bawaan: nama jenisnya"),
    number: z.string().trim().min(1).max(60).nullable().optional(),
    issuedOn: date.nullable().optional(),
    validUntil: date.nullable().optional().describe("kosong: berlaku seterusnya"),
    fileName: z.string().trim().min(1).max(200),
    content: base64.describe("PDF, JPG, atau PNG, base64, paling besar 5 MB"),
  }),
) {}

export class UpdateBusinessDocumentDto extends createZodDto(
  z.object({
    title: z.string().trim().max(120).optional(),
    number: z.string().trim().min(1).max(60).nullable().optional(),
    issuedOn: date.nullable().optional(),
    validUntil: date.nullable().optional(),
  }),
) {}

export class BusinessDocumentIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

const documentSchema = z.object({
  id: ulidSchema,
  kind: z.enum(DOCUMENT_KINDS),
  title: z.string(),
  number: z.string().nullable(),
  issuedOn: z.string().nullable(),
  validUntil: z.string().nullable(),
  status: z
    .enum(["no_expiry", "valid", "expiring", "expired"])
    .describe("expiring: habis dalam 30 hari; berlaku sampai akhir tanggal validUntil"),
  daysLeft: z.number().int().nullable(),
  fileName: z.string(),
  createdAt: z.iso.datetime(),
});

export class BusinessDocumentDto extends createZodDto(documentSchema) {}

export class BusinessProfileDto extends createZodDto(
  z.object({
    rowVersion: z.number().int().describe("ETag untuk If-Match; 0 sebelum profil pertama kali disimpan"),
    name: z.string(),
    timezone: z.string(),
    currency: z.literal("IDR"),
    address,
    phone: z.string().nullable(),
    hasLogo: z.boolean().describe("logo dibaca di GET /v1/business-profile/logo"),
    nib: z.string().nullable(),
    nibInProcessSince: z.string().nullable(),
    nibStatus: z.enum(["registered", "in_process", "missing"]),
    nibDeadline: z.string().nullable().describe("hari terakhir NIB boleh dalam proses"),
    nibDaysLeft: z.number().int().nullable(),
    npwp: z.string().nullable(),
    pkp: z.boolean(),
    buyerDataRetentionMonths: z
      .number()
      .int()
      .describe("bulan setelah pesanan, data pribadi pembeli dianonimkan (backend doc 8.34)"),
    documents: z.array(documentSchema),
    today: z.string().describe("tanggal hari ini di zona waktu bisnis, dasar status di atas"),
  }),
) {}

export function documentDto(d: DocumentView) {
  return { ...d, createdAt: d.createdAt.toISOString() };
}

export function profileDto(p: BusinessProfileView) {
  return { ...p, currency: "IDR" as const, documents: p.documents.map(documentDto) };
}
