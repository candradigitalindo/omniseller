import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_ENTITIES, type AuditLogRow, type AuditNames, auditDiff, auditEntryView, refsOf } from "./audit-view";

const at = new Date("2026-10-06T03:00:00Z");
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
  length_mm: null,
  width_mm: null,
  height_mm: null,
  is_bundle: false,
  status: "active",
  deleted_at: null,
};
const row = (over: Partial<AuditLogRow>): AuditLogRow => ({
  id: "A1",
  createdAt: at,
  actorType: "user",
  actorId: "U1",
  requestId: "R1",
  action: "update",
  entityType: "variant",
  entityId: "V1",
  before: variant,
  after: variant,
  ...over,
});
const NAMES: Record<string, string> = {
  U1: "Rina Wulandari",
  U2: "Budi Santoso",
  V1: "KAOS-HTM-L",
  W1: "Gudang Jakarta",
  W2: "Gudang Bandung",
  R1: "Admin",
  O1: "MN-2610-0001",
  D1: "PC Gudang",
};
const names: AuditNames = {
  of: (_ref, id) => NAMES[id] ?? null,
  actor: (type, id) => (id && (type === "user" || type === "device") ? (NAMES[id] ?? null) : null),
};
const view = (r: AuditLogRow, seesCost = true) => {
  const diff = auditDiff(r);
  if (!diff) throw new Error("no diff");
  return auditEntryView(r, diff, names, { seesCost });
};

describe("audit log as a seller reads it", () => {
  it("shows the fields that changed, by their API names, with who did it", () => {
    const e = view(
      row({ after: { ...variant, base_price: 69000, updated_at: "2026-10-06T03:00:00Z", row_version: 2 } }),
    );
    expect(e).toMatchObject({
      actor: { type: "user", id: "U1", name: "Rina Wulandari" },
      change: "updated",
      label: "KAOS-HTM-L",
      changes: [{ field: "basePrice", before: 65000, after: 69000 }],
    });
  });

  it("leaves out a row whose recognisable fields did not change", () => {
    // a marketplace warehouse seen again by a sync
    const cw = { id: "C1", name: "Gudang toko", store_id: "S1", warehouse_id: "W1", last_seen_at: "2026-10-05" };
    expect(
      auditDiff(row({ entityType: "channel_warehouse", before: cw, after: { ...cw, last_seen_at: "2026-10-06" } })),
    ).toBeNull();
    // object keys in another order are the same value
    expect(
      auditDiff(row({ after: { ...variant, attributes: { Ukuran: "L", Warna: "Hitam" }, row_version: 2 } })),
    ).toBeNull();
  });

  it("names the records a row points at, and what names the row itself", () => {
    const movement = {
      id: "M1",
      variant_id: "V1",
      warehouse_id: "W1",
      type: "adjustment",
      on_hand_delta: -2,
      on_hand_after: 18,
      reserved_delta: 0,
      damaged_delta: 0,
      buffer_delta: 0,
      reason: "damaged",
      note: "",
      actor_user_id: "U1",
    };
    const r = row({ action: "insert", entityType: "stock_movement", entityId: "M1", before: null, after: movement });
    const e = view(r);
    expect(e.label).toBe("KAOS-HTM-L");
    expect(e.changes).toEqual([
      { field: "variant", before: null, after: "KAOS-HTM-L" },
      { field: "warehouse", before: null, after: "Gudang Jakarta" },
      { field: "type", before: null, after: "adjustment" },
      { field: "onHandDelta", before: null, after: -2 },
      { field: "onHandAfter", before: null, after: 18 },
      // damaged and buffer stock did not move, and the note is empty: none of them is listed
      { field: "reason", before: null, after: "damaged" },
    ]);
    // stock moved to damaged is listed
    const toDamaged = row({
      action: "insert",
      entityType: "stock_movement",
      entityId: "M2",
      before: null,
      after: { ...movement, on_hand_delta: -2, damaged_delta: 2 },
    });
    expect(view(toDamaged).changes.map((c) => c.field)).toContain("damagedDelta");
    const diff = auditDiff(r)!;
    const refs = refsOf([{ row: r, diff }]);
    expect([...(refs.get("variant") ?? [])]).toEqual(["V1"]);
    expect([...(refs.get("warehouse") ?? [])]).toEqual(["W1"]);
  });

  it("names an entry by a record it points at even when that did not change", () => {
    const rule = { id: "X1", store_id: "S1", variant_id: "V1", mode: "percent", value: 50, active: true };
    const r = row({ entityType: "stock_allocation_rule", entityId: "X1", before: rule, after: { ...rule, value: 60 } });
    const diff = auditDiff(r)!;
    expect(diff.fields.map((c) => c.spec.field)).toEqual(["value"]);
    // the variant names the rule, so it is read although only the value changed
    expect([...(refsOf([{ row: r, diff }]).get("variant") ?? [])]).toEqual(["V1"]);
    expect(view(r).label).toBe("KAOS-HTM-L");
  });

  it("reads a field inside a JSON column: the reason of a cancellation", () => {
    const ev = {
      id: "E1",
      order_id: "O1",
      type: "cancel_requested",
      payload: { label: "Pembeli membatalkan", reason: "buyer_request" },
    };
    const e = view(row({ action: "insert", entityType: "order_event", before: null, after: ev }));
    expect(e.label).toBe("MN-2610-0001");
    expect(e.changes).toEqual([
      { field: "order", before: null, after: "MN-2610-0001" },
      { field: "reason", before: null, after: "Pembeli membatalkan" },
    ]);
  });

  it("shows what a deleted row held, named from its old values", () => {
    const ur = { id: "X1", user_id: "U2", role_id: "R1" };
    const e = view(row({ action: "delete", entityType: "user_role", before: ur, after: null }));
    expect(e).toMatchObject({
      change: "deleted",
      label: "Budi Santoso",
      changes: [
        { field: "user", before: "Budi Santoso", after: null },
        { field: "role", before: "Admin", after: null },
      ],
    });
  });

  it("lists only what a created or deleted row held: empty values stay out", () => {
    const product = {
      id: "P1",
      name: "Kaos Polos",
      sku: "KAOS",
      description: "",
      brand: null,
      category_path: [],
      status: "active",
      attribute_names: [],
    };
    expect(
      view(row({ action: "insert", entityType: "product", before: null, after: product })).changes.map((c) => c.field),
    ).toEqual(["name", "sku", "status"]);
    // a rule for the whole store has no variant and no marketplace warehouse
    const rule = {
      id: "X1",
      store_id: "S1",
      channel_warehouse_id: null,
      variant_id: null,
      mode: "percent",
      value: 50,
      buffer: 0,
      priority: 0,
      active: true,
    };
    const removed = view(row({ action: "delete", entityType: "stock_allocation_rule", before: rule, after: null }));
    expect(removed.changes.map((c) => c.field)).toEqual(["store", "mode", "value", "buffer", "priority", "active"]);
    const created = view(
      row({
        action: "insert",
        entityType: "variant",
        before: null,
        after: { ...variant, attributes: {}, barcode: "" },
      }),
    );
    expect(created.changes.map((c) => c.field)).not.toContain("attributes");
    expect(created.changes.map((c) => c.field)).not.toContain("barcode");
  });

  it("calls archiving and bringing back a deletion and a restore", () => {
    const archived = { ...variant, deleted_at: "2026-10-06T03:00:00Z", status: "archived" };
    expect(auditDiff(row({ after: archived }))).toEqual({ change: "deleted", fields: [] });
    expect(auditDiff(row({ before: archived, after: variant }))).toEqual({ change: "restored", fields: [] });
  });

  it("starts counters at nothing: a new export shows its status only", () => {
    const ex = { id: "X1", status: "queued", download_count: 0 };
    expect(view(row({ action: "insert", entityType: "data_export", before: null, after: ex })).changes).toEqual([
      { field: "status", before: null, after: "queued" },
    ]);
    // a download is the count going up
    const e = view(row({ entityType: "data_export", before: ex, after: { ...ex, download_count: 1 } }));
    expect(e.changes).toEqual([{ field: "downloadCount", before: 0, after: 1 }]);
    expect(e.label).toBeNull();
  });

  it("keeps cost prices from readers without finance:read, in the changes and in the row", () => {
    const changed = { ...variant, cost_price: 36000, base_price: 69000 };
    const e = view(row({ after: changed }), false);
    expect(e.changes).toEqual([
      { field: "costPrice", before: null, after: null, hidden: true },
      { field: "basePrice", before: 65000, after: 69000 },
    ]);
    expect(e.before).not.toHaveProperty("cost_price");
    expect(e.after).not.toHaveProperty("cost_price");
    expect(e.after).toHaveProperty("base_price", 69000);
    // with finance:read the row is untouched
    expect(view(row({ after: changed }), true).after).toHaveProperty("cost_price", 36000);
  });

  it("names a print agent that acted, and nobody for the system", () => {
    const d = { id: "D9", name: "Laptop Kasir", warehouse_id: null, revoked_at: null };
    expect(
      view(row({ actorType: "device", actorId: "D1", entityType: "device", before: d, after: { ...d, name: "Kasir" } }))
        .actor,
    ).toEqual({ type: "device", id: "D1", name: "PC Gudang" });
    expect(view(row({ actorType: "system", actorId: "U1", after: { ...variant, status: "archived" } })).actor).toEqual({
      type: "system",
      id: "U1",
      name: null,
    });
  });

  it("shows a table it does not know yet, without fields, so nothing audited goes missing", () => {
    expect(
      auditDiff(row({ entityType: "future_table", before: { id: "F1", x: 1 }, after: { id: "F1", x: 2 } })),
    ).toEqual({ change: "updated", fields: [] });
  });

  it("leaves a name out when the record is gone, rather than showing its id", () => {
    const rp = { id: "X1", role_id: "R-GONE", permission_id: "P-GONE" };
    const e = view(row({ action: "insert", entityType: "role_permission", before: null, after: rp }));
    expect(e.label).toBeNull();
    expect(e.changes).toEqual([
      { field: "role", before: null, after: null },
      { field: "permission", before: null, after: null },
    ]);
  });
});

describe("the view and the audit triggers agree", () => {
  const triggers = readFileSync(join(__dirname, "../../../drizzle/sql/20_triggers.sql"), "utf8");
  // each audit trigger: its table and the CREATE TRIGGER text inside ensure_trigger(...)
  const audited = [...triggers.matchAll(/ensure_trigger\('(\w+)', '\w+',\s*'([\s\S]*?)'\);/g)]
    .map((m) => ({ table: m[1]!, statement: m[2]! }))
    .filter((a) => a.statement.includes("EXECUTE FUNCTION audit_row("));
  const generic = /ARRAY\[([^\]]*)\][\s\S]*?audit_trg/.exec(triggers)?.[1] ?? "";
  const tables = new Set([...audited.map((a) => a.table), ...[...generic.matchAll(/'(\w+)'/g)].map((m) => m[1]!)]);

  it("knows every audited table", () => {
    expect(tables.size).toBeGreaterThan(20);
    expect([...tables].filter((t) => !AUDIT_ENTITIES[t])).toEqual([]);
  });

  it("shows every column a trigger fires on, so no row it writes is taken for noise", () => {
    const missing: string[] = [];
    for (const { table, statement } of audited) {
      const columns = new Set([
        ...[...statement.matchAll(/OLD\.(\w+)/g)].map((m) => m[1]!),
        ...(/UPDATE OF ([\w, ]+?) (?:OR|ON) /.exec(statement)?.[1]?.split(/,\s*/) ?? []),
      ]);
      const shown = new Set([...(AUDIT_ENTITIES[table]?.fields ?? []).map((s) => s.column), "deleted_at"]);
      for (const c of columns) if (!shown.has(c)) missing.push(`${table}.${c}`);
    }
    expect(missing).toEqual([]);
  });
});
