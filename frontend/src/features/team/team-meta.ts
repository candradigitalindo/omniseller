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
  return [...modules.values()];
}

/**
 * The scope a dialog sends: null removes the limit (every store or warehouse); an empty list is never
 * sent, since the api would read it as no limit too and a seller might expect "none".
 */
export function scopeBody(all: boolean, chosen: readonly string[]): string[] | null {
  return all || chosen.length === 0 ? null : [...chosen];
}
