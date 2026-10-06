import type { components } from "@/lib/api/schema";

export type AuditEntry = components["schemas"]["AuditPageDto_Output"]["items"][number];
export type AuditChange = AuditEntry["changes"][number];

/**
 * What a seller looks for in the log (PRD FR-USR-04: prices, stock, cancellations, access, store
 * connections), each as the tables the api audits (backend doc 8.28).
 */
export const AUDIT_KINDS = {
  catalog: ["product", "variant", "channel_listing", "listing_copy", "listing_draft"],
  stock: ["stock_movement", "stock_count", "stock_transfer", "stock_allocation_rule"],
  orders: ["order_event", "return_request", "handover"],
  access: ["user_role", "user_store_scope", "user_warehouse_scope", "role", "role_permission"],
  stores: ["store", "channel_warehouse", "warehouse", "device"],
  data: ["data_export", "migration_job", "store_cutover"],
} as const satisfies Record<string, readonly string[]>;
export type AuditKind = keyof typeof AUDIT_KINDS;

export function auditKindOf(value: string | null): AuditKind | null {
  return value && value in AUDIT_KINDS ? (value as AuditKind) : null;
}

export const PERIODS = ["7", "30", "90"] as const;
export type Period = (typeof PERIODS)[number];

export function periodOf(value: string | null): Period | null {
  return (PERIODS as readonly string[]).includes(value ?? "") ? (value as Period) : null;
}

/** The start of the last `days` days, for `from`. */
export function periodFrom(period: Period, now = Date.now()): string {
  return new Date(now - Number(period) * 86_400_000).toISOString();
}

const find = (e: AuditEntry, field: string) => e.changes.find((c) => c.field === field);
// the api sends only fields that changed, so `after` alone says where a change went
const becomes = (e: AuditEntry, field: string, value: unknown) => find(e, field)?.after === value;
const set = (e: AuditEntry, field: string) => {
  const c = find(e, field);
  return !!c && c.before == null && c.after != null;
};

/** Every entry message under `audit.title_*` (audit-meta.test.ts checks they exist). */
export const TITLE_KEYS = [
  "product_created",
  "product_updated",
  "product_deleted",
  "product_restored",
  "variant_created",
  "variant_updated",
  "variant_deleted",
  "variant_restored",
  "channel_listing_created",
  "channel_listing_updated",
  "channel_listing_deleted",
  "store_created",
  "store_updated",
  "store_disconnected",
  "store_deleted",
  "role_created",
  "role_updated",
  "role_deleted",
  "role_permission_created",
  "role_permission_deleted",
  "user_role_created",
  "user_role_deleted",
  "user_store_scope_created",
  "user_store_scope_deleted",
  "user_warehouse_scope_created",
  "user_warehouse_scope_deleted",
  "channel_warehouse_created",
  "channel_warehouse_updated",
  "channel_warehouse_deleted",
  "stock_allocation_rule_created",
  "stock_allocation_rule_updated",
  "stock_allocation_rule_deleted",
  "warehouse_created",
  "warehouse_updated",
  "warehouse_deleted",
  "warehouse_restored",
  "stock_movement_adjustment",
  "stock_movement_count_apply",
  "stock_movement_migration_initial",
  "order_event_created",
  "data_export_created",
  "data_export_downloaded",
  "data_export_updated",
  "migration_job_created",
  "store_cutover_created",
  "store_cutover_undone",
  "store_cutover_updated",
  "device_created",
  "device_updated",
  "device_revoked",
  "handover_created",
  "handover_completed",
  "handover_cancelled",
  "handover_updated",
  "listing_copy_created",
  "listing_copy_updated",
  "listing_draft_published",
  "listing_draft_updated",
  "listing_draft_deleted",
  "return_request_answered",
  "return_request_received",
  "return_request_updated",
  "stock_count_created",
  "stock_count_submitted",
  "stock_count_reopened",
  "stock_count_approved",
  "stock_count_applied",
  "stock_count_cancelled",
  "stock_count_updated",
  "stock_transfer_created",
  "stock_transfer_sent",
  "stock_transfer_received",
  "stock_transfer_cancelled",
  "stock_transfer_updated",
  "other_created",
  "other_updated",
  "other_deleted",
  "other_restored",
] as const;
export type TitleKey = (typeof TITLE_KEYS)[number];

/** Every field the api names in `changes` that has a label under `audit.field_*`. */
export const AUDIT_FIELDS = [
  "name",
  "sku",
  "description",
  "brand",
  "categoryPath",
  "status",
  "attributeNames",
  "barcode",
  "attributes",
  "costPrice",
  "basePrice",
  "weightG",
  "lengthMm",
  "widthMm",
  "heightMm",
  "isBundle",
  "store",
  "externalSku",
  "price",
  "variant",
  "channel",
  "syncMode",
  "defaultWarehouse",
  "role",
  "permission",
  "user",
  "warehouse",
  "mappingStatus",
  "isDefault",
  "active",
  "channelWarehouse",
  "mode",
  "value",
  "buffer",
  "priority",
  "code",
  "address",
  "type",
  "onHandDelta",
  "onHandAfter",
  "damagedDelta",
  "bufferDelta",
  "reason",
  "note",
  "order",
  "downloadCount",
  "sourceApp",
  "kind",
  "fileName",
  "undoUntil",
  "labelPrinter",
  "documentPrinter",
  "revokedAt",
  "courier",
  "receivedBy",
  "sourceStore",
  "targetStore",
  "itemsTotal",
  "itemsDrafted",
  "itemsFailed",
  "externalTargetItemId",
  "responseStatus",
  "decision",
  "receivedAt",
  "blind",
  "zeroUncounted",
  "applyRequestedAt",
  "fromWarehouse",
  "toWarehouse",
  "receiptNote",
] as const;
export type AuditFieldName = (typeof AUDIT_FIELDS)[number];

export function fieldName(field: string): AuditFieldName | null {
  return (AUDIT_FIELDS as readonly string[]).includes(field) ? (field as AuditFieldName) : null;
}

/**
 * The message of an entry under `audit.title_*`: what was done, in the seller's words. Status changes
 * name the step (a manifest completed, a count approved); a table without messages of its own says
 * "Mengubah data" and the like.
 */
export function titleKey(e: AuditEntry): TitleKey {
  const key = stepKey(e);
  return (TITLE_KEYS as readonly string[]).includes(key) ? (key as TitleKey) : `other_${e.change}`;
}

function stepKey(e: AuditEntry): string {
  const base = `${e.entityType}_${e.change}`;
  if (e.change !== "updated" && e.entityType !== "stock_movement") return base;
  switch (e.entityType) {
    case "stock_movement": {
      const type = find(e, "type")?.after;
      return typeof type === "string" ? `stock_movement_${type}` : base;
    }
    case "store":
      return becomes(e, "status", "disconnected") ? "store_disconnected" : base;
    case "data_export":
      return find(e, "downloadCount") ? "data_export_downloaded" : base;
    case "store_cutover":
      return becomes(e, "status", "undone") ? "store_cutover_undone" : base;
    case "device":
      return set(e, "revokedAt") ? "device_revoked" : base;
    case "handover":
      if (becomes(e, "status", "completed")) return "handover_completed";
      return becomes(e, "status", "cancelled") ? "handover_cancelled" : base;
    case "listing_draft":
      return becomes(e, "status", "published") ? "listing_draft_published" : base;
    case "return_request":
      if (set(e, "receivedAt")) return "return_request_received";
      return find(e, "responseStatus") ? "return_request_answered" : base;
    case "stock_count":
      if (set(e, "applyRequestedAt")) return "stock_count_approved";
      if (becomes(e, "status", "review")) return "stock_count_submitted";
      if (becomes(e, "status", "counting")) return "stock_count_reopened";
      if (becomes(e, "status", "applied")) return "stock_count_applied";
      return becomes(e, "status", "cancelled") ? "stock_count_cancelled" : base;
    case "stock_transfer":
      for (const s of ["sent", "received", "cancelled"]) {
        if (becomes(e, "status", s)) return `stock_transfer_${s}`;
      }
      return base;
    default:
      return base;
  }
}

/**
 * Where a coded value is named: [namespace, key prefix]. Most come from the screens that set them, so the
 * log says what those screens say.
 */
export const VALUE_LABELS: Record<string, [namespace: string, prefix: string]> = {
  "product.status": ["products", "status_"],
  "variant.status": ["products", "status_"],
  "channel_listing.status": ["listings", "status_"],
  "store.status": ["stores", "status_"],
  "store.syncMode": ["audit", "syncMode_"],
  "channel_warehouse.mappingStatus": ["warehouses", "mapping_"],
  "stock_allocation_rule.mode": ["storeRules", "mode_"],
  "stock_movement.type": ["audit", "movement_"],
  "stock_movement.reason": ["stock", "reason_"],
  "data_export.status": ["dataExport", "status_"],
  "migration_job.sourceApp": ["audit", "app_"],
  "migration_job.kind": ["audit", "importKind_"],
  "store_cutover.status": ["audit", "cutover_"],
  "handover.status": ["shipping", "handover_"],
  "listing_copy.status": ["audit", "copy_"],
  "listing_draft.status": ["audit", "draft_"],
  "return_request.kind": ["returns", "kind_"],
  "return_request.responseStatus": ["returns", "response_"],
  "stock_count.status": ["counts", "status_"],
  "stock_count.mode": ["counts", "mode_"],
  "stock_transfer.status": ["transfers", "status_"],
};

/** The message key naming a coded value, if the log knows one. */
export function valueKey(entityType: string, field: string, value: unknown): string | null {
  const where = VALUE_LABELS[`${entityType}.${field}`];
  return where && typeof value === "string" ? `${where[0]}.${where[1]}${value}` : null;
}

/** Fields shown as Rupiah, as a signed quantity, or as a moment in the business's time zone. */
export const MONEY_FIELDS = new Set(["costPrice", "basePrice", "price"]);
export const DELTA_FIELDS = new Set(["onHandDelta", "damagedDelta", "bufferDelta"]);
export const MOMENT_FIELDS = new Set(["undoUntil", "revokedAt", "receivedAt", "applyRequestedAt"]);

const ADDRESS_PARTS = ["line1", "district", "city", "province", "postalCode"];

/** A JSON value as one line: attributes as "Warna: Hitam", an address by its parts, lists joined. */
export function plainValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length > 0 ? value.map(plainValue).join(", ") : "—";
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (ADDRESS_PARTS.some((k) => typeof o[k] === "string")) {
      return ADDRESS_PARTS.map((k) => o[k])
        .filter((v): v is string => typeof v === "string" && v !== "")
        .join(", ");
    }
    const parts = Object.entries(o).map(([k, v]) => `${k}: ${plainValue(v)}`);
    return parts.length > 0 ? parts.join(", ") : "—";
  }
  const text = String(value);
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/**
 * The changes worth a line: on a created or deleted record, a value that only repeats the entry's own
 * name ("Memberi peran kepada Sari Dewi", then "Pengguna: Sari Dewi") is left out.
 */
export function shownChanges(e: AuditEntry): AuditChange[] {
  if (e.change === "updated") return e.changes;
  return e.changes.filter((c) => {
    const v = e.change === "deleted" ? c.before : c.after;
    return !(e.label && v === e.label);
  });
}

export interface AuditGroup {
  key: string;
  entries: AuditEntry[];
}

/**
 * Entries of one action together: the api writes a row per table, so a role change or a signup is many
 * rows with one requestId. Only neighbours join, so the log stays in time order.
 */
export function groupEntries(entries: readonly AuditEntry[]): AuditGroup[] {
  const groups: AuditGroup[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    const head = last?.entries[0];
    if (
      last &&
      head &&
      e.requestId &&
      head.requestId === e.requestId &&
      head.actor.type === e.actor.type &&
      head.actor.id === e.actor.id
    ) {
      last.entries.push(e);
    } else {
      groups.push({ key: e.id, entries: [e] });
    }
  }
  return groups;
}

/** A group longer than this shows its first entries and a button for the rest. */
export const GROUP_PREVIEW = 3;
export const GROUP_COLLAPSE_AT = 5;
