import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Two-step verification and signed-in devices (backend doc 8.30). */

const iso = z.iso.datetime();
const challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Token tidak valid.");
const totpCode = z
  .string()
  .trim()
  .regex(/^[0-9]{6}$/, "Kode terdiri dari 6 angka.")
  .describe("kode 6 angka dari aplikasi autentikator");
const backupCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9 -]{10,20}$/, "Kode cadangan tidak valid.")
  .describe("salah satu kode cadangan, sekali pakai");
const password = z.string().min(1).max(128);

/** Exactly one of `code` and `backupCode`. */
const oneFactor = <T extends { code?: string | undefined; backupCode?: string | undefined }>(v: T) =>
  (v.code === undefined) !== (v.backupCode === undefined);
const oneFactorIssue = { message: "Isi kode dari aplikasi autentikator atau kode cadangan.", path: ["code"] };

export class LoginTwoFactorDto extends createZodDto(
  z
    .object({
      challenge: challenge.describe("dari jawaban 401 auth.two_factor_required"),
      code: totpCode.optional(),
      backupCode: backupCode.optional(),
    })
    .refine(oneFactor, oneFactorIssue),
) {}

export class PasswordConfirmDto extends createZodDto(z.object({ password })) {}

export class TwoFactorStatusDto extends createZodDto(
  z.object({
    enabled: z.boolean(),
    enabledAt: iso.nullable(),
    backupCodesLeft: z.number().int().describe("kode cadangan yang belum dipakai"),
    recommended: z.boolean().describe("Owner dan Admin dianjurkan memakai verifikasi dua langkah"),
  }),
) {}

export class TwoFactorSetupDto extends createZodDto(
  z.object({
    secret: z.string().describe("base32, untuk diketik bila QR tidak bisa dipindai"),
    uri: z.string().describe("otpauth:// yang dibaca aplikasi autentikator"),
    qrSvg: z.string().describe("QR dari uri sebagai SVG"),
  }),
) {}

export class EnableTwoFactorDto extends createZodDto(z.object({ code: totpCode })) {}

export class BackupCodesDto extends createZodDto(
  z.object({ backupCodes: z.array(z.string()).describe("hanya tampil sekali; simpan di tempat aman") }),
) {}

export class DisableTwoFactorDto extends createZodDto(
  z
    .object({ password, code: totpCode.optional(), backupCode: backupCode.optional() })
    .refine(oneFactor, oneFactorIssue),
) {}

const sessionSchema = z.object({
  id: z.string(),
  current: z.boolean().describe("sesi permintaan ini"),
  createdAt: iso.describe("waktu masuk"),
  lastSeenAt: iso.describe("terakhir dipakai, diperbarui paling sering sekali per jam"),
  ip: z.string().nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
});
export class SessionListDto extends createZodDto(z.object({ items: z.array(sessionSchema), next_cursor: z.null() })) {}

export class SessionIdParamDto extends createZodDto(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{22}$/) })) {}
