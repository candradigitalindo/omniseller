import { describe, expect, it } from "vitest";
import type { CommerceOperation } from "./commerce-types.js";
import { safeCommerceResult, validateCommerceInput } from "./commerce-validation.js";

const operation: CommerceOperation = {
  id: "fixture",
  channel: "tiktokshop",
  principalKind: "creator",
  title: "Fixture",
  group: "Affiliate",
  method: "POST",
  path: "/fixture",
  scopes: ["creator.showcase.write"],
  write: true,
  officialUrl: "https://partner.tiktokshop.com",
  available: true,
  unavailableReason: null,
  fields: [
    { name: "path.product_id", label: "ID", type: "string", required: true },
    { name: "query.page_size", label: "Page", type: "integer", required: false, minimum: 1, maximum: 100 },
    {
      name: "body.products",
      label: "Products",
      type: "array",
      itemType: "object",
      required: true,
      maximum: 2,
      children: [{ name: "id", label: "ID", type: "string", required: true }],
    },
  ],
};
describe("reviewed commerce input", () => {
  const input = () => ({
    path: { product_id: "9223372036854775806" },
    query: { page_size: 20 },
    body: { products: [{ id: "9223372036854775807" }] },
  });
  it("preserves exact external IDs and validates nested documented fields", () =>
    expect(() => validateCommerceInput(operation, input())).not.toThrow());
  it("refuses unknown top-level, nested and credential fields rather than stripping them", () => {
    expect(() => validateCommerceInput(operation, { ...input(), query: { app_secret: "secret" } })).toThrow(
      "credentials",
    );
    expect(() =>
      validateCommerceInput(operation, { ...input(), body: { products: [{ id: "a", undeclared: "b" }] } }),
    ).toThrow("undocumented");
    expect(() =>
      validateCommerceInput(operation, { ...input(), query: { page_size: 20, url: "https://private.invalid" } }),
    ).toThrow("undocumented");
  });
  it("enforces required inputs, page bounds and item bounds", () => {
    expect(() => validateCommerceInput(operation, { ...input(), path: {} })).toThrow("required");
    expect(() => validateCommerceInput(operation, { ...input(), query: { page_size: 101 } })).toThrow("invalid number");
    expect(() =>
      validateCommerceInput(operation, { ...input(), body: { products: [{ id: "1" }, { id: "2" }, { id: "3" }] } }),
    ).toThrow("invalid list");
  });
  it("refuses unsafe numeric integer IDs", () => {
    const numeric = {
      ...operation,
      fields: [{ name: "body.id", label: "ID", type: "integer" as const, required: true }],
    };
    expect(() => validateCommerceInput(numeric, { body: { id: Number("9223372036854775807") } })).toThrow(
      "external IDs",
    );
  });
  it("treats array bounds as cardinality, allows numeric zero items and handles documented empty cursors", () => {
    const fields: CommerceOperation = {
      ...operation,
      fields: [
        { name: "body.ids", label: "IDs", type: "array", itemType: "integer", minimum: 1, maximum: 2, required: true },
        { name: "query.cursor", label: "Cursor", type: "string", required: true, allowEmpty: true },
      ],
    };
    expect(() => validateCommerceInput(fields, { body: { ids: [0] }, query: { cursor: "" } })).not.toThrow();
    expect(() => validateCommerceInput(fields, { body: { ids: [] }, query: { cursor: "" } })).toThrow("invalid list");
    expect(() =>
      validateCommerceInput(
        { ...fields, fields: [{ name: "query.cursor", label: "Cursor", type: "string", required: true }] },
        { query: { cursor: "" } },
      ),
    ).toThrow("required");
  });
});
describe("commerce retention", () => {
  it("removes credentials/private category assets and buyer PII at every level", () => {
    expect(
      safeCommerceResult({
        products: [
          {
            id: "1",
            title: "Product",
            buyer: { name: "PRIVATE" },
            recipient_address: "PRIVATE",
            category_asset_cipher: "PRIVATE",
            access_token: "PRIVATE",
          },
        ],
        next_page_token: "page-2",
      }),
    ).toEqual({ products: [{ id: "1", title: "Product" }] });
  });
  it("bounds retained lists and depth", () => {
    expect((safeCommerceResult(Array.from({ length: 101 }, (_, i) => i)) as unknown[]).length).toBe(100);
    expect(safeCommerceResult({ value: Number.NaN })).toEqual({ value: null });
  });
});
