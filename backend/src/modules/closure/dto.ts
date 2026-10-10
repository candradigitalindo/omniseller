import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { ClosureView } from "./closure.service";

const iso = z.iso.datetime();

export class CloseAccountDto extends createZodDto(
  z.object({
    businessName: z.string().trim().min(1).max(200).describe("nama bisnis diketik ulang sebagai konfirmasi"),
    password: z.string().min(1).max(200).describe("kata sandi pengguna yang menutup akun"),
  }),
) {}

const closureSchema = z.object({
  status: z.enum(["active", "suspended", "closing", "closed"]),
  closingAt: iso.nullable(),
  /** When the business's data is deleted; null while the account is open. */
  purgeAfter: iso.nullable(),
  closedBy: z.object({ id: ulidSchema, name: z.string().nullable() }).nullable(),
  revokeLinks: z
    .array(z.object({ channel: z.string(), url: z.string() }))
    .describe("marketplace tempat izin OmniSeller masih bisa dicabut penjual"),
  purgeAfterDays: z.number().int().describe("hari sampai data dihapus setelah akun ditutup"),
});

export class AccountClosureDto extends createZodDto(closureSchema) {}

export function closureView(v: ClosureView): z.infer<typeof closureSchema> {
  return {
    status: v.status,
    closingAt: v.closingAt?.toISOString() ?? null,
    purgeAfter: v.purgeAfter?.toISOString() ?? null,
    closedBy: v.closedBy,
    revokeLinks: v.revokeLinks,
    purgeAfterDays: v.purgeAfterDays,
  };
}
