import { describe, expect, it } from "vitest";
import { historyEntry, type ProductAuditRow, withoutCost } from "./product-history";

const at = new Date("2026-10-04T03:00:00Z");
const variant = {
  id: "V1",
  tenant_id: "T",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  row_version: 1,
  product_id: "P1",
  sku: "KAOS-HTM-L",
  name: "Hitam, L",
  barcode: null,
  attributes: { Warna: "Hitam", Ukuran: "L" },
  cost_price: 35000,
  base_price: 65000,
  weight_g: 200,
  status: "active",
  deleted_at: null,
};
const row = (over: Partial<ProductAuditRow>): ProductAuditRow => ({
  id: "A1",
  createdAt: at,
  actorType: "user",
  actorId: "U1",
  action: "update",
  entityType: "variant",
  entityId: "V1",
  before: variant,
  after: variant,
  ...over,
});

describe("product history (FR-PRD-11)", () => {
  it("lists the fields that changed with their labels, without the columns every write touches", () => {
    const e = historyEntry(
      row({
        after: {
          ...variant,
          updated_at: "2026-10-04T03:00:00Z",
          row_version: 2,
          base_price: 69000,
          barcode: "8991234567891",
          // the same attributes in another key order are not a change
          attributes: { Ukuran: "L", Warna: "Hitam" },
        },
      }),
    );
    expect(e).toEqual({
      id: "A1",
      at,
      actor: { type: "user", id: "U1" },
      action: "updated",
      target: { type: "variant", id: "V1", sku: "KAOS-HTM-L", name: "Hitam, L" },
      changes: [
        { field: "barcode", label: "Barcode", before: null, after: "8991234567891" },
        { field: "basePrice", label: "Harga dasar", before: 65000, after: 69000 },
      ],
    });
  });

  it("names creating, deleting (soft or not), and restoring, and skips writes that changed nothing", () => {
    expect(historyEntry(row({ action: "insert", before: null }))).toMatchObject({ action: "created", changes: [] });
    expect(historyEntry(row({ action: "delete", after: null }))).toMatchObject({
      action: "deleted",
      target: { sku: "KAOS-HTM-L" },
    });
    expect(
      historyEntry(row({ after: { ...variant, deleted_at: "2026-10-04T03:00:00Z", sku: "KAOS-HTM-L" } })),
    ).toMatchObject({ action: "deleted", changes: [] });
    expect(historyEntry(row({ before: { ...variant, deleted_at: "2026-10-03T00:00:00Z" } }))).toMatchObject({
      action: "restored",
    });
    expect(historyEntry(row({ after: { ...variant, updated_at: "2026-10-04T03:00:00Z", row_version: 2 } }))).toBeNull();
    expect(historyEntry(row({ entityType: "channel_listing" }))).toBeNull();
  });

  it("labels product fields and keeps a column it does not know under its own name", () => {
    const product = { id: "P1", name: "Kaos", sku: "KAOS", category_path: null, status: "active" };
    const e = historyEntry(
      row({
        entityType: "product",
        entityId: "P1",
        before: product,
        after: { ...product, category_path: "Fashion > Kaos", status: "archived", season: "2027" },
      }),
    );
    expect(e?.changes).toEqual([
      { field: "categoryPath", label: "Kategori", before: null, after: "Fashion > Kaos" },
      { field: "status", label: "Status", before: "active", after: "archived" },
      { field: "season", label: "season", before: null, after: "2027" },
    ]);
  });

  it("keeps the cost price's change but not its values for readers without finance:read", () => {
    const e = historyEntry(row({ after: { ...variant, cost_price: 41000, base_price: 69000 } }))!;
    expect(withoutCost(e).changes).toEqual([
      { field: "costPrice", label: "HPP", before: null, after: null, hidden: true },
      { field: "basePrice", label: "Harga dasar", before: 65000, after: 69000 },
    ]);
    const priceOnly = historyEntry(row({ after: { ...variant, base_price: 69000 } }))!;
    expect(withoutCost(priceOnly)).toBe(priceOnly);
  });
});
