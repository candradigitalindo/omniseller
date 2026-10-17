/**
 * The audit log as a seller reads it (PRD FR-USR-04, backend doc 8.28): for each row of `audit_log`, what
 * it is about, and every field a person would recognise before and after, with the records it points at
 * (a variant, a warehouse, a role) named instead of their ids. A row whose recognisable fields did not
 * change is left out: a marketplace warehouse seen again by a sync touches only `last_seen_at`. Pure
 * functions; `AuditLogService` reads the rows and the names.
 */

/** Records other rows point at, named through the module that owns them. */
export type AuditRef =
  | "user"
  | "role"
  | "permission"
  | "store"
  | "warehouse"
  | "channelWarehouse"
  | "variant"
  | "order"
  | "plan";

export type AuditChange = "created" | "updated" | "deleted" | "restored";

export interface AuditLogRow {
  id: string;
  createdAt: Date;
  actorType: "user" | "system" | "api_key" | "device";
  actorId: string | null;
  requestId: string | null;
  action: "insert" | "update" | "delete";
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface AuditField {
  /** The column in the row; `payload.label` reads inside a JSON column. */
  column: string;
  /** The field's name in the API: camelCase, and a reference without its `Id` (`warehouse`). */
  field: string;
  ref?: AuditRef;
  /** A cost price: only holders of finance:read see it (`seesCost`). */
  cost?: true;
  /** Left out when the row is created: a counter that starts at zero. */
  notOnCreate?: true;
  /** Left out of a created or deleted row when zero: a part of the change that did not move. */
  omitZero?: true;
}

interface EntitySpec {
  /** What names the row: one of its columns, else a record it points at; the first one found. */
  label: ({ column: string } | { ref: AuditRef; column: string })[];
  /** The fields a seller recognises, in the order of the screens that change them. */
  fields: AuditField[];
}

const camel = (column: string) => column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const f = (column: string, extra: Partial<AuditField> = {}): AuditField => ({ column, field: camel(column), ...extra });
const r = (column: string, ref: AuditRef): AuditField => ({ column, field: camel(column.replace(/_id$/, "")), ref });

/**
 * Every audited table (drizzle/sql/20_triggers.sql). A table missing here is shown without fields. A
 * trigger that fires only on some columns (`UPDATE OF`, `WHEN (OLD.x ...)`) makes every row it writes
 * matter, so those columns must be fields here, or the row would be taken for noise and left out;
 * audit-view.spec.ts reads the triggers and checks.
 */
export const AUDIT_ENTITIES: Record<string, EntitySpec> = {
  affiliate_product_query: { label: [], fields: [r("store_id", "store"), f("status"), f("total"), f("error_code")] },
  listing_price_change: {
    label: [],
    fields: [r("store_id", "store"), f("expected_price"), f("requested_price"), f("observed_price"), f("status")],
  },
  product: {
    label: [{ column: "name" }],
    fields: [f("name"), f("sku"), f("description"), f("brand"), f("category_path"), f("status"), f("attribute_names")],
  },
  variant: {
    label: [{ column: "sku" }],
    fields: [
      f("sku"),
      f("name"),
      f("barcode"),
      f("attributes"),
      f("cost_price", { cost: true }),
      f("base_price"),
      f("weight_g"),
      f("length_mm"),
      f("width_mm"),
      f("height_mm"),
      f("is_bundle"),
      f("status"),
    ],
  },
  channel_listing: {
    label: [{ column: "title" }, { column: "external_sku" }],
    fields: [r("store_id", "store"), f("external_sku"), f("price"), f("status"), r("variant_id", "variant")],
  },
  store: {
    label: [{ column: "name" }],
    fields: [f("channel"), f("name"), f("status"), f("sync_mode"), r("default_warehouse_id", "warehouse")],
  },
  role: { label: [{ column: "name" }], fields: [f("name"), f("description")] },
  role_permission: {
    label: [{ ref: "role", column: "role_id" }],
    fields: [r("role_id", "role"), r("permission_id", "permission")],
  },
  // an account disabled or enabled again, and two-step verification turned on or off (backend doc 8.30)
  user: {
    label: [{ column: "name" }],
    fields: [f("status"), f("totp_enabled", { field: "twoFactorEnabled" })],
  },
  user_role: { label: [{ ref: "user", column: "user_id" }], fields: [r("user_id", "user"), r("role_id", "role")] },
  user_store_scope: {
    label: [{ ref: "user", column: "user_id" }],
    fields: [r("user_id", "user"), r("store_id", "store")],
  },
  user_warehouse_scope: {
    label: [{ ref: "user", column: "user_id" }],
    fields: [r("user_id", "user"), r("warehouse_id", "warehouse")],
  },
  channel_warehouse: {
    label: [{ column: "name" }],
    fields: [
      r("store_id", "store"),
      f("name"),
      r("warehouse_id", "warehouse"),
      f("mapping_status"),
      f("is_default"),
      f("active"),
    ],
  },
  stock_allocation_rule: {
    label: [
      { ref: "variant", column: "variant_id" },
      { ref: "store", column: "store_id" },
    ],
    fields: [
      r("store_id", "store"),
      r("channel_warehouse_id", "channelWarehouse"),
      r("variant_id", "variant"),
      f("mode"),
      f("value"),
      f("buffer"),
      f("priority"),
      f("active"),
    ],
  },
  warehouse: {
    label: [{ column: "name" }],
    fields: [f("code"), f("name"), f("address"), f("is_default"), f("active")],
  },
  stock_movement: {
    label: [{ ref: "variant", column: "variant_id" }],
    fields: [
      r("variant_id", "variant"),
      r("warehouse_id", "warehouse"),
      f("type"),
      f("on_hand_delta"),
      f("on_hand_after"),
      f("damaged_delta", { omitZero: true }),
      f("buffer_delta", { omitZero: true }),
      f("reason"),
      f("note"),
    ],
  },
  // only cancellations asked by a seller are audited (`cancel_requested`); the payload carries the reason
  order_event: {
    label: [{ ref: "order", column: "order_id" }],
    fields: [r("order_id", "order"), { column: "payload.label", field: "reason" }],
  },
  data_export: { label: [], fields: [f("status"), f("download_count", { notOnCreate: true })] },
  migration_job: { label: [{ column: "file_name" }], fields: [f("source_app"), f("kind"), f("file_name")] },
  store_cutover: {
    label: [{ ref: "store", column: "store_id" }],
    fields: [r("store_id", "store"), f("status"), f("undo_until")],
  },
  device: {
    label: [{ column: "name" }],
    fields: [f("name"), r("warehouse_id", "warehouse"), f("label_printer"), f("document_printer"), f("revoked_at")],
  },
  handover: {
    label: [{ column: "number" }],
    fields: [f("courier"), r("warehouse_id", "warehouse"), f("status"), f("received_by")],
  },
  listing_copy: {
    label: [],
    fields: [
      r("source_store_id", "store"),
      r("target_store_id", "store"),
      f("status"),
      f("items_total", { notOnCreate: true }),
      f("items_drafted", { notOnCreate: true }),
      f("items_failed", { notOnCreate: true }),
    ],
  },
  listing_draft: {
    label: [{ column: "title" }],
    fields: [r("target_store_id", "store"), f("status"), f("external_target_item_id")],
  },
  return_request: {
    label: [{ column: "external_return_id" }],
    fields: [r("order_id", "order"), f("kind"), f("response_status"), f("decision"), f("received_at")],
  },
  stock_count: {
    label: [{ column: "number" }],
    // approving sets apply_requested_at while the status waits for the worker to apply the count
    fields: [
      r("warehouse_id", "warehouse"),
      f("mode"),
      f("blind"),
      f("status"),
      f("zero_uncounted"),
      f("apply_requested_at"),
    ],
  },
  // when parcels must be ready (backend doc 8.31)
  courier_cutoff: {
    label: [{ column: "courier" }],
    fields: [r("warehouse_id", "warehouse"), f("courier"), f("cutoff_time"), f("days_of_week"), f("active")],
  },
  courier_holiday: {
    label: [{ column: "courier" }, { column: "holiday_date" }],
    fields: [f("holiday_date"), f("courier"), f("note")],
  },
  operating_hours: {
    label: [{ column: "name" }],
    fields: [f("name"), f("schedule"), f("valid_from"), f("valid_to")],
  },
  // automatic order processing rules (backend doc 8.37)
  order_rule: {
    label: [{ column: "name" }],
    fields: [f("name"), f("priority"), f("active"), f("conditions"), f("actions")],
  },
  // the logo and a document's file are files: their ids say only that one was set, replaced, or removed
  // account closure and reopening (backend doc 8.36), written by audit_tenant()
  tenant: {
    label: [],
    fields: [f("status"), f("closing_at"), f("purge_after")],
  },
  business_profile: {
    label: [],
    fields: [
      f("address"),
      f("phone"),
      f("logo_file_id", { field: "logo" }),
      f("nib"),
      f("nib_in_process_since"),
      f("npwp"),
      f("pkp"),
      f("buyer_data_retention_months", { field: "buyerDataRetentionMonths" }),
    ],
  },
  business_document: {
    label: [{ column: "title" }],
    fields: [
      f("kind"),
      f("title"),
      f("number"),
      f("issued_on"),
      f("valid_until"),
      f("file_object_id", { field: "file" }),
    ],
  },
  stock_transfer: {
    label: [{ column: "number" }],
    fields: [
      r("from_warehouse_id", "warehouse"),
      r("to_warehouse_id", "warehouse"),
      f("status"),
      f("note"),
      f("receipt_note"),
    ],
  },
  // the subscription and its invoices (backend doc 8.32): which plan was in force when, and how it was paid
  subscription: {
    label: [{ ref: "plan", column: "plan_id" }],
    fields: [
      r("plan_id", "plan"),
      f("status"),
      f("current_period_start"),
      f("current_period_end"),
      r("next_plan_id", "plan"),
      f("ended_at"),
    ],
  },
  invoice: {
    label: [{ column: "number" }],
    fields: [
      f("number"),
      r("plan_id", "plan"),
      f("status"),
      f("amount"),
      f("credit_amount", { omitZero: true }),
      f("period_start"),
      f("period_end"),
      f("due_at"),
      f("paid_at"),
      f("paid_amount"),
      f("payment_method"),
      f("payment_channel"),
    ],
  },
};

/** The column of a row, or of a JSON column inside it (`payload.label`). */
function columnValue(row: Record<string, unknown>, column: string): unknown {
  let v: unknown = row;
  for (const part of column.split(".")) {
    v = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[part] : undefined;
  }
  return v ?? null;
}

/** Stable comparison of JSON values: object keys in any order are the same value. */
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

/** A value worth showing on its own (a created or deleted row): not null and not empty. */
function present(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  // an empty list has no keys either
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** A value of a created or deleted row worth a line: present, and not a zero that only says nothing moved. */
function listed(spec: AuditField, v: unknown): boolean {
  return present(v) && !(spec.omitZero && v === 0);
}

export interface AuditDiff {
  change: AuditChange;
  fields: { spec: AuditField; before: unknown; after: unknown }[];
}

/** What a row changed that a seller recognises; null when nothing they would see changed. */
export function auditDiff(row: AuditLogRow): AuditDiff | null {
  const spec = AUDIT_ENTITIES[row.entityType];
  const before = row.before ?? {};
  const after = row.after ?? {};
  if (row.action === "insert") {
    const fields = (spec?.fields ?? [])
      .filter((s) => !s.notOnCreate)
      .map((s) => ({ spec: s, before: null, after: columnValue(after, s.column) }))
      .filter((c) => listed(c.spec, c.after));
    return { change: "created", fields };
  }
  if (row.action === "delete") {
    const fields = (spec?.fields ?? [])
      .map((s) => ({ spec: s, before: columnValue(before, s.column), after: null }))
      .filter((c) => listed(c.spec, c.before));
    return { change: "deleted", fields };
  }
  // archived and brought back (products, variants, warehouses keep their row)
  if (!before.deleted_at && after.deleted_at) return { change: "deleted", fields: [] };
  if (before.deleted_at && !after.deleted_at) return { change: "restored", fields: [] };
  // a table this file does not know yet: shown, so nothing audited goes missing
  if (!spec) return { change: "updated", fields: [] };
  const fields = spec.fields
    .map((s) => ({ spec: s, before: columnValue(before, s.column), after: columnValue(after, s.column) }))
    .filter((c) => canonical(c.before) !== canonical(c.after));
  return fields.length > 0 ? { change: "updated", fields } : null;
}

/** Names of the records rows point at; null when the record is gone (a deleted role). */
export interface AuditNames {
  of(ref: AuditRef, id: string): string | null;
  /** The person or print agent who acted. */
  actor(type: AuditLogRow["actorType"], id: string | null): string | null;
}

/** The ids each kind of record must be named for these rows: their references and what names them. */
export function refsOf(rows: { row: AuditLogRow; diff: AuditDiff }[]): Map<AuditRef, Set<string>> {
  const out = new Map<AuditRef, Set<string>>();
  const add = (ref: AuditRef, v: unknown) => {
    if (typeof v !== "string" || v === "") return;
    let ids = out.get(ref);
    if (!ids) {
      ids = new Set();
      out.set(ref, ids);
    }
    ids.add(v);
  };
  for (const { row, diff } of rows) {
    for (const c of diff.fields) {
      if (c.spec.ref) {
        add(c.spec.ref, c.before);
        add(c.spec.ref, c.after);
      }
    }
    const shown = row.action === "delete" ? row.before : row.after;
    for (const l of AUDIT_ENTITIES[row.entityType]?.label ?? []) {
      if ("ref" in l && shown) add(l.ref, columnValue(shown, l.column));
    }
  }
  return out;
}

export interface FieldChangeView {
  field: string;
  before: unknown;
  after: unknown;
  /** The values are left out for this reader (a cost price without finance:read). */
  hidden?: true;
}

export interface AuditEntryView {
  actor: { type: AuditLogRow["actorType"]; id: string | null; name: string | null };
  change: AuditChange;
  label: string | null;
  changes: FieldChangeView[];
  /** The row's own columns, cost prices left out for readers without finance:read. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Cost columns of each table, kept out of `before` and `after` for readers without finance:read. */
function withoutCostColumns(entityType: string, values: Record<string, unknown> | null) {
  const cost = (AUDIT_ENTITIES[entityType]?.fields ?? []).filter((s) => s.cost).map((s) => s.column);
  if (!values || cost.length === 0) return values;
  const out = { ...values };
  for (const c of cost) delete out[c];
  return out;
}

/** One row as the seller reads it: names instead of ids, and cost prices only for finance:read. */
export function auditEntryView(
  row: AuditLogRow,
  diff: AuditDiff,
  names: AuditNames,
  opts: { seesCost: boolean },
): AuditEntryView {
  const named = (s: AuditField, v: unknown) => (s.ref ? (typeof v === "string" ? names.of(s.ref, v) : null) : v);
  const shown = (row.action === "delete" ? row.before : row.after) ?? {};
  let label: string | null = null;
  for (const l of AUDIT_ENTITIES[row.entityType]?.label ?? []) {
    const v = columnValue(shown, l.column);
    const name = "ref" in l ? (typeof v === "string" ? names.of(l.ref, v) : null) : typeof v === "string" ? v : null;
    if (name) {
      label = name;
      break;
    }
  }
  return {
    actor: { type: row.actorType, id: row.actorId, name: names.actor(row.actorType, row.actorId) },
    change: diff.change,
    label,
    changes: diff.fields.map(({ spec, before, after }) =>
      spec.cost && !opts.seesCost
        ? { field: spec.field, before: null, after: null, hidden: true }
        : { field: spec.field, before: named(spec, before), after: named(spec, after) },
    ),
    before: opts.seesCost ? row.before : withoutCostColumns(row.entityType, row.before),
    after: opts.seesCost ? row.after : withoutCostColumns(row.entityType, row.after),
  };
}
