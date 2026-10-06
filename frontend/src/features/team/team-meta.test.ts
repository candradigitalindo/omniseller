import { describe, expect, it } from "vitest";
import { emailProblem, grantableRoles, permissionMatrix, type Role, scopeBody, scopeSummary } from "./team-meta";

const role = (id: string, permissions: string[]): Role => ({
  id,
  name: id,
  isSystem: true,
  description: null,
  permissions,
});

describe("team rules", () => {
  it("offers only roles whose every permission the user holds", () => {
    const roles = [role("Owner", ["order:read", "settings:billing"]), role("Gudang", ["order:read", "shipment:pack"])];
    expect(grantableRoles(roles, ["order:read", "shipment:pack", "settings:user"]).map((r) => r.id)).toEqual([
      "Gudang",
    ]);
    expect(grantableRoles(roles, ["order:read", "shipment:pack", "settings:billing"]).map((r) => r.id)).toEqual([
      "Owner",
      "Gudang",
    ]);
  });

  it("reads a missing scope as everything, and names the stores of a limited one", () => {
    const names = new Map([["S1", "Toko Rina Shopee"]]);
    expect(scopeSummary(null, names)).toEqual({ all: true });
    expect(scopeSummary(["S1", "S9"], names)).toEqual({ all: false, names: ["Toko Rina Shopee", "S9"] });
  });

  it("sends no limit as null, never as an empty list", () => {
    expect(scopeBody(true, ["S1"])).toBeNull();
    expect(scopeBody(false, [])).toBeNull();
    expect(scopeBody(false, ["S1"])).toEqual(["S1"]);
  });

  it("checks an email before inviting", () => {
    expect(emailProblem(" ")).toBe("required");
    expect(emailProblem("rina@toko")).toBe("email");
    expect(emailProblem(" rina@tokorina.id ")).toBeNull();
  });

  it("groups permissions by module with the roles holding each", () => {
    const matrix = permissionMatrix(
      [
        { code: "order:read", module: "Pesanan", description: "Lihat pesanan" },
        { code: "order:cancel", module: "Pesanan", description: "Batalkan pesanan" },
        { code: "inventory:read", module: "Stok", description: null },
      ],
      [role("Admin", ["order:read", "order:cancel"]), role("Viewer", ["order:read", "inventory:read"])],
    );
    expect(matrix.map((m) => [m.module, m.rows.map((r) => r.code)])).toEqual([
      ["Pesanan", ["order:read", "order:cancel"]],
      ["Stok", ["inventory:read"]],
    ]);
    expect(matrix[0]?.rows[1]?.byRole).toEqual({ Admin: true, Viewer: false });
  });
});
