import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import { passwordSchema } from "../../common/security/password";
import type { Principal, RoleRow, UserView } from "./identity.repository";
import type { InvitationView } from "./invitations.service";

/** Request and response DTOs of the identity and auth endpoints (backend doc 4: dto/). */

const email = z.email("Email tidak valid.").max(254);
const personName = z.string().trim().min(1).max(80);
const iso = z.iso.datetime();
const secretToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Token tidak valid.");

export class IdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class PageQueryDto extends createZodDto(paginationQuery) {}

// ---- auth ----

export class SignupDto extends createZodDto(
  z.object({
    businessName: z.string().trim().min(2).max(80),
    name: personName,
    email,
    password: passwordSchema,
  }),
) {}

export class LoginDto extends createZodDto(
  z.object({
    email,
    password: z.string().min(1).max(128),
    /** tenant slug, only when the email belongs to several businesses */
    tenant: z
      .string()
      .regex(/^[a-z0-9-]{3,40}$/)
      .optional(),
  }),
) {}

export class PasswordResetRequestDto extends createZodDto(z.object({ email })) {}
export class PasswordResetConfirmDto extends createZodDto(z.object({ token: secretToken, password: passwordSchema })) {}
export class InvitationTokenDto extends createZodDto(z.object({ token: secretToken })) {}
export class AcceptInvitationDto extends createZodDto(
  z.object({ token: secretToken, name: personName, password: passwordSchema }),
) {}
export class ChangePasswordDto extends createZodDto(
  z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }),
) {}

const roleRef = z.object({ id: ulidSchema, name: z.string() });

export const meSchema = z.object({
  user: z.object({ id: ulidSchema, name: z.string(), email: z.string(), locale: z.enum(["id", "en"]) }),
  tenant: z.object({ id: ulidSchema, name: z.string(), slug: z.string(), timezone: z.string(), status: z.string() }),
  permissions: z.array(z.string()),
  roles: z.array(roleRef),
  storeScope: z.array(ulidSchema).nullable(),
  warehouseScope: z.array(ulidSchema).nullable(),
});
export class MeDto extends createZodDto(meSchema) {}

export function meView(p: Principal): z.infer<typeof meSchema> {
  return {
    user: { id: p.user.id, name: p.user.name, email: p.user.email, locale: p.user.locale },
    tenant: p.tenant,
    permissions: p.permissions,
    roles: p.roles,
    storeScope: p.storeScope,
    warehouseScope: p.warehouseScope,
  };
}

export class InvitationPreviewDto extends createZodDto(
  z.object({ tenantName: z.string(), email: z.string(), roleName: z.string(), expiresAt: iso }),
) {}

// ---- users ----

const userSchema = z.object({
  id: ulidSchema,
  name: z.string(),
  email: z.string(),
  status: z.enum(["invited", "active", "disabled"]),
  roles: z.array(roleRef),
  storeIds: z.array(ulidSchema).nullable(),
  warehouseIds: z.array(ulidSchema).nullable(),
  lastLoginAt: iso.nullable(),
  createdAt: iso,
});
export class UserDto extends createZodDto(userSchema) {}
export class UserPageDto extends createZodDto(pageSchema(userSchema)) {}

export function userView(u: UserView): z.infer<typeof userSchema> {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.status,
    roles: u.roles,
    storeIds: u.storeIds,
    warehouseIds: u.warehouseIds,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

export class UpdateUserDto extends createZodDto(
  z
    .object({ name: personName.optional(), status: z.enum(["active", "disabled"]).optional() })
    .refine((v) => v.name !== undefined || v.status !== undefined, { message: "Tidak ada perubahan." }),
) {}

export class SetRolesDto extends createZodDto(z.object({ roleIds: z.array(ulidSchema).min(1).max(10) })) {}

export class SetScopesDto extends createZodDto(
  z
    .object({
      storeIds: z.array(ulidSchema).max(500).nullable().optional(),
      warehouseIds: z.array(ulidSchema).max(500).nullable().optional(),
    })
    .refine((v) => v.storeIds !== undefined || v.warehouseIds !== undefined, { message: "Tidak ada perubahan." }),
) {}

// ---- roles and permissions ----

const roleSchema = z.object({
  id: ulidSchema,
  name: z.string(),
  isSystem: z.boolean(),
  description: z.string().nullable(),
  permissions: z.array(z.string()),
});
export class RoleListDto extends createZodDto(z.object({ items: z.array(roleSchema), next_cursor: z.null() })) {}
export const roleView = (r: RoleRow) => r;

export class PermissionListDto extends createZodDto(
  z.object({
    items: z.array(z.object({ code: z.string(), module: z.string(), description: z.string().nullable() })),
    next_cursor: z.null(),
  }),
) {}

// ---- invitations ----

const invitationSchema = z.object({
  id: ulidSchema,
  email: z.string(),
  roleId: ulidSchema,
  roleName: z.string(),
  status: z.enum(["pending", "sent", "expired"]),
  expiresAt: iso,
  sentAt: iso.nullable(),
  createdAt: iso,
});
export class InvitationDto extends createZodDto(invitationSchema) {}
export class InvitationPageDto extends createZodDto(pageSchema(invitationSchema)) {}
export class CreateInvitationDto extends createZodDto(z.object({ email, roleId: ulidSchema })) {}

export function invitationView(i: InvitationView): z.infer<typeof invitationSchema> {
  return {
    id: i.id,
    email: i.email,
    roleId: i.roleId,
    roleName: i.roleName,
    status: i.status,
    expiresAt: i.expiresAt.toISOString(),
    sentAt: i.sentAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}
