import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type User = components["schemas"]["UserPageDto_Output"]["items"][number];
export type Invitation = components["schemas"]["InvitationPageDto_Output"]["items"][number];
export type Role = components["schemas"]["RoleListDto_Output"]["items"][number];
export type PermissionInfo = components["schemas"]["PermissionListDto_Output"]["items"][number];

export const USER_TONE: Record<User["status"], Tone> = {
  active: "success",
  invited: "info",
  disabled: "neutral",
};

export const INVITATION_TONE: Record<Invitation["status"], Tone> = {
  pending: "neutral",
  sent: "info",
  expired: "warning",
};

/**
 * Roles this user may give or invite with: every permission of the role must be one the user holds
 * (backend identity rules). The api refuses the others, so they are not offered.
 */
export function grantableRoles(roles: readonly Role[], mine: readonly string[]): Role[] {
  const held = new Set(mine);
  return roles.filter((r) => r.permissions.every((p) => held.has(p)));
}

/** "Semua toko", one name, or "3 toko", from the user's store scope (null: no limit). */
export function scopeSummary(
  ids: readonly string[] | null,
  names: ReadonlyMap<string, string>,
): { all: true } | { all: false; names: string[] } {
  if (ids === null) return { all: true };
  return { all: false, names: ids.map((id) => names.get(id) ?? id) };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailProblem(value: string): "required" | "email" | null {
  const v = value.trim();
  if (!v) return "required";
  return EMAIL.test(v) ? null : "email";
}

/** Modules of the permission catalogue in the order screens list them, each with its label (`team.module_*`). */
export const PERMISSION_MODULES = [
  "order",
  "shipment",
  "return",
  "inventory",
  "catalog",
  "price",
  "promo",
  "affiliate",
  "finance",
  "chat",
  "report",
  "settings",
  "research",
  "audit",
  "data",
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export function isKnownModule(module: string): module is PermissionModule {
  return (PERMISSION_MODULES as readonly string[]).includes(module);
}

const moduleRank = (module: string) => {
  const i = (PERMISSION_MODULES as readonly string[]).indexOf(module);
  return i < 0 ? PERMISSION_MODULES.length : i;
};

export interface MatrixModule {
  module: string;
  rows: { code: string; description: string | null; byRole: Record<string, boolean> }[];
}

/** Permissions grouped by module, with which role holds each (L41 "matriks izin per modul"). */
export function permissionMatrix(permissions: readonly PermissionInfo[], roles: readonly Role[]): MatrixModule[] {
  const modules = new Map<string, MatrixModule>();
  for (const p of permissions) {
    const m = modules.get(p.module) ?? { module: p.module, rows: [] };
    m.rows.push({
      code: p.code,
      description: p.description,
      byRole: Object.fromEntries(roles.map((r) => [r.id, r.permissions.includes(p.code)])),
    });
    modules.set(p.module, m);
  }
  // known modules in the screen's order, others after them as they came (stable sort)
  return [...modules.values()].sort((a, b) => moduleRank(a.module) - moduleRank(b.module));
}

/** Built-in roles first, then the business's own (backend doc 8.33), each group as the api listed it. */
export function orderedRoles<R extends Pick<Role, "isSystem">>(roles: readonly R[]): R[] {
  return [...roles.filter((r) => r.isSystem), ...roles.filter((r) => !r.isSystem)];
}

/** What a custom role would start with when copied from another: only what the user may give. */
export function copiedPermissions(from: Pick<Role, "permissions">, mine: readonly string[]): string[] {
  const held = new Set(mine);
  return from.permissions.filter((p) => held.has(p));
}

export const ROLE_NAME_MAX = 40;

/** A custom role's form, checked as the api does before sending. */
export function roleProblems(input: { name: string; permissions: readonly string[] }): {
  name?: "required" | "tooLong";
  permissions?: "required";
} {
  const name = input.name.trim();
  return {
    ...(name === "" ? { name: "required" as const } : name.length > ROLE_NAME_MAX ? { name: "tooLong" as const } : {}),
    ...(input.permissions.length === 0 ? { permissions: "required" as const } : {}),
  };
}

/** Whether the caller holds every permission they would grant, on any plan. */
export function roleBlock(role: Pick<Role, "permissions">, mine: readonly string[]): "permissions" | null {
  const held = new Set(mine);
  return role.permissions.every((p) => held.has(p)) ? null : "permissions";
}

/**
 * The scope a dialog sends: null removes the limit (every store or warehouse); an empty list is never
 * sent, since the api would read it as no limit too and a seller might expect "none".
 */
export function scopeBody(all: boolean, chosen: readonly string[]): string[] | null {
  return all || chosen.length === 0 ? null : [...chosen];
}
