import type { CommerceOperation } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { systemContext } from "../../common/context/request-context";
import { authorizeCommerceInput, authorizeOperation, publicOperation } from "./commerce-policy";

const base: CommerceOperation = {
  id: "fixture",
  channel: "tiktokshop",
  principalKind: "creator",
  title: "Showcase",
  group: "Affiliate",
  method: "GET",
  path: "/affiliate_creator/202405/showcases/products",
  scopes: ["creator.showcase.read"],
  write: false,
  available: true,
  unavailableReason: null,
  fields: [],
  officialUrl: "https://partner.tiktokshop.com",
};
describe("commerce authorization", () => {
  const context = () => systemContext("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  it("requires commerce, owning-domain and creator-account permissions together", () => {
    const ctx = context();
    expect(() => authorizeOperation(ctx, base, base.scopes)).not.toThrow();
    for (const permission of ["commerce:read", "affiliate:read", "affiliate:account_read"]) {
      const limited = { ...ctx, permissions: new Set([...ctx.permissions].filter((p) => p !== permission)) };
      expect(() => authorizeOperation(limited, base, base.scopes)).toThrow("Izin operasi");
    }
  });
  it("requires write permission and rejects warehouse-restricted generic data", () => {
    const ctx = context();
    expect(() => authorizeOperation({ ...ctx, warehouseScope: new Set() }, base, base.scopes)).toThrow(
      "seluruh gudang",
    );
    const write = { ...base, write: true };
    expect(() =>
      authorizeOperation(
        { ...ctx, permissions: new Set(["commerce:read", "affiliate:read", "affiliate:account_read"]) },
        write,
        base.scopes,
      ),
    ).toThrow("Izin operasi");
  });
  it("enforces all scopes conservatively and supports explicit documented alternatives", () => {
    const op = { ...base, scopes: ["scope.a", "scope.b"] };
    expect(() => authorizeOperation(context(), op, ["scope.a"])).toThrow("izin API");
    expect(() => authorizeOperation(context(), { ...op, scopeMode: "any" }, ["scope.b"])).not.toThrow();
  });
  it("keeps stock and price commands in owning modules", () => {
    for (const path of [
      "/api/v2/product/update_stock",
      "/api/v2/product/update_price",
      "/product/202309/products/{product_id}/inventory/update",
      "/product/202309/products/{product_id}/prices/update",
    ]) {
      expect(publicOperation({ ...base, path, write: true }).available).toBe(false);
    }
  });
  it("protects nested product stock payloads and requires the extra price permission", () => {
    const operation = { ...base, path: "/product/202309/products/{product_id}", write: true };
    const ctx = context();
    expect(() => authorizeCommerceInput(ctx, operation, { body: { skus: [{ inventory: { quantity: 2 } }] } })).toThrow(
      "validation.failed",
    );
    expect(() =>
      authorizeCommerceInput(
        { ...ctx, permissions: new Set([...ctx.permissions].filter((p) => p !== "price:write")) },
        operation,
        { body: { skus: [{ price: { sale_price: "20000" } }] } },
      ),
    ).toThrow("Izin ubah harga");
    expect(() => authorizeCommerceInput(ctx, operation, { body: { title: "Product title" } })).not.toThrow();
  });
  it("treats Shopee app-program approval separately from OAuth scopes", () => {
    const op: CommerceOperation = {
      ...base,
      channel: "shopee",
      principalKind: "seller",
      path: "/api/v2/ams/get_open_campaign_added_product",
      scopes: [],
      authMode: "shopee_app_program",
      eligibility: "unverified",
    };
    expect(publicOperation(op).available).toBe(true);
    expect(() => authorizeOperation(context(), op, [])).not.toThrow();
    expect(publicOperation({ ...op, authMode: "oauth_scope" }).available).toBe(false);
  });
});
