/**
 * A product's change history (PRD FR-PRD-11, UI L14 "Riwayat perubahan", backend doc 8.23) from the
 * audit log rows of the product and its variants: who did what, and each changed field before and after.
 * Pure functions; the rows come from `AuditService.entriesIn`.
 */

export interface ProductAuditRow {
  id: string;
  createdAt: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export type HistoryAction = "created" | "updated" | "deleted" | "restored";

export interface FieldChange {
  /** The field's name in the API (`costPrice`). */
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export interface HistoryEntry {
  id: string;
  at: Date;
  actor: { type: string; id: string | null };
  action: HistoryAction;
  target: { type: "product" | "variant"; id: string; sku: string | null; name: string | null };
  changes: FieldChange[];
}

/** Columns that change on every write or never mean anything to the seller. */
const SKIPPED = new Set(["id", "tenant_id", "created_at", "updated_at", "row_version", "product_id", "deleted_at"]);

const FIELDS: Record<"product" | "variant", Record<string, [field: string, label: string]>> = {
  product: {
    name: ["name", "Nama produk"],
    sku: ["sku", "SKU produk"],
    description: ["description", "Deskripsi"],
    brand: ["brand", "Merek"],
    category_path: ["categoryPath", "Kategori"],
    status: ["status", "Status"],
    attribute_names: ["attributeNames", "Nama atribut"],
  },
  variant: {
    sku: ["sku", "SKU varian"],
    name: ["name", "Nama varian"],
    barcode: ["barcode", "Barcode"],
    attributes: ["attributes", "Atribut"],
    cost_price: ["costPrice", "HPP"],
    base_price: ["basePrice", "Harga dasar"],
    weight_g: ["weightG", "Berat (gram)"],
    length_mm: ["lengthMm", "Panjang (mm)"],
    width_mm: ["widthMm", "Lebar (mm)"],
    height_mm: ["heightMm", "Tinggi (mm)"],
    is_bundle: ["isBundle", "Paket produk"],
    status: ["status", "Status"],
  },
};

const camel = (column: string) => column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Stable comparison of JSON values: object keys in any order are the same value. */
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** One audit row as a history entry; null for a row that changed nothing a seller would see. */
export function historyEntry(row: ProductAuditRow): HistoryEntry | null {
  if (row.entityType !== "product" && row.entityType !== "variant") return null;
  const type = row.entityType;
  const before = row.before ?? {};
  const after = row.after ?? {};
  let action: HistoryAction;
  if (row.action === "insert") action = "created";
  else if (row.action === "delete") action = "deleted";
  else if (!before.deleted_at && after.deleted_at) action = "deleted";
  else if (before.deleted_at && !after.deleted_at) action = "restored";
  else action = "updated";

  const changes: FieldChange[] = [];
  if (action === "updated") {
    // in the order of the product form (FIELDS), columns it does not know last
    const known = Object.keys(FIELDS[type]);
    const rank = (column: string) => (known.includes(column) ? known.indexOf(column) : known.length);
    const columns = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(
      (a, b) => rank(a) - rank(b) || a.localeCompare(b),
    );
    for (const column of columns) {
      if (SKIPPED.has(column) || same(before[column], after[column])) continue;
      const [field, label] = FIELDS[type][column] ?? [camel(column), column];
      changes.push({ field, label, before: before[column] ?? null, after: after[column] ?? null });
    }
    if (changes.length === 0) return null;
  }
  const shown = row.action === "delete" ? before : after;
  return {
    id: row.id,
    at: row.createdAt,
    actor: { type: row.actorType, id: row.actorId },
    action,
    target: {
      type,
      id: row.entityId,
      sku: typeof shown.sku === "string" ? shown.sku : null,
      name: typeof shown.name === "string" ? shown.name : null,
    },
    changes,
  };
}
