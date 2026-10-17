import {
  DATA_EXPORT_STATUSES,
  DOCUMENT_JOB_STATUSES,
  HANDOVER_STATUSES,
  INVOICE_STATUSES,
  LISTING_COPY_STATUSES,
  LISTING_DRAFT_STATUSES,
  LISTING_PRICE_CHANGE_STATUSES,
  MIGRATION_JOB_STATUSES,
  ORDER_STATUSES,
  PERMISSION_CODES,
  PRINT_JOB_STATUSES,
  RETURN_REQUEST_STATUSES,
  SHIPMENT_STATUSES,
  STOCK_COUNT_STATUSES,
  STOCK_TRANSFER_STATUSES,
  STORE_CUTOVER_STATUSES,
  SUBSCRIPTION_STATUSES,
  SYNC_JOB_STATUSES,
} from "@omniseller/shared";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { testHandles } from "../setup/handles";

/**
 * `pnpm test:schema` (backend doc 7.3, 12.1, 12.3): the database follows the conventions, and the
 * Drizzle mirror matches the SQL migrations column by column.
 */
const h = testHandles();

/** Tenant tables without updated_at/row_version by design (ledgers and event logs). */
const APPEND_ONLY = new Set([
  "stock_movement",
  "order_event",
  "order_external_ref",
  "outbox_event",
  "audit_log",
  "migration_row_error",
]);
/** Tables whose tenant_id is nullable by design. */
const NULLABLE_TENANT = new Set(["file_object", "webhook_inbox"]);
/** Global tables that carry a tenant_id only as routing data, filled in after the fact. */
const GLOBAL_WITH_TENANT = new Set(["webhook_inbox"]);
const NO_RLS = GLOBAL_WITH_TENANT;

type Row = Record<string, any>;
let client: Awaited<ReturnType<typeof h.raw>>;
const q = async <T extends Row = Row>(text: string, params: unknown[] = []) =>
  (await client.query<T>(text, params)).rows;

beforeAll(async () => {
  client = await h.raw("migrator");
});

async function parentTables(): Promise<{ name: string; kind: string; rls: boolean; force: boolean }[]> {
  return q(`SELECT c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition AND c.relname <> 'schema_migration'
             ORDER BY 1`);
}

async function columnsOf(table: string): Promise<Map<string, { nullable: boolean; type: string }>> {
  const rows = await q<{ column_name: string; is_nullable: string; domain_name: string | null; udt_name: string }>(
    `SELECT column_name, is_nullable, domain_name, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Map(
    rows.map((r) => [r.column_name, { nullable: r.is_nullable === "YES", type: r.domain_name ?? r.udt_name }]),
  );
}

describe("schema conventions", () => {
  it("every Drizzle table exists with exactly the same columns and nullability", async () => {
    const tables = Object.values(schema as Record<string, unknown>).filter(
      (v): v is PgTable => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v,
    );
    expect(tables.length).toBeGreaterThan(30);
    const dbTables = new Set((await parentTables()).map((t) => t.name));
    const mirrored = new Set<string>();
    for (const table of tables) {
      const cfg = getTableConfig(table);
      mirrored.add(cfg.name);
      expect(dbTables, `table ${cfg.name} missing in database`).toContain(cfg.name);
      const dbCols = await columnsOf(cfg.name);
      const tsCols = new Map(cfg.columns.map((c) => [c.name, c]));
      expect([...tsCols.keys()].sort(), `columns of ${cfg.name}`).toEqual([...dbCols.keys()].sort());
      for (const [name, col] of tsCols) {
        const dbCol = dbCols.get(name)!;
        // generated columns are nullable in the catalog and optional in Drizzle
        if (col.generated) continue;
        expect(!col.notNull, `nullability of ${cfg.name}.${name}`).toBe(dbCol.nullable);
      }
    }
    expect(
      [...dbTables].filter((t) => !mirrored.has(t)),
      "tables without a Drizzle mirror",
    ).toEqual([]);
  });

  it("every id and reference column uses the ulid domain", async () => {
    const bad = await q(`SELECT table_name, column_name, coalesce(domain_name, udt_name) AS type
                           FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name <> 'schema_migration'
                            AND (column_name = 'id' OR (column_name LIKE '%\\_id' AND column_name NOT LIKE 'external\\_%'
                                 AND column_name NOT IN ('event_id', 'actor_id', 'request_id', 'trace_id', 'queue_job_id', 'job_id')))
                            AND coalesce(domain_name, '') <> 'ulid'
                            AND table_name NOT IN (SELECT relname FROM pg_class WHERE relispartition)`);
    expect(bad).toEqual([]);
  });

  it("every tenant table has the base columns (append-only tables excepted)", async () => {
    for (const t of await parentTables()) {
      const cols = await columnsOf(t.name);
      if (!cols.has("tenant_id")) continue;
      expect(cols.get("tenant_id")?.nullable, `${t.name}.tenant_id nullability`).toBe(NULLABLE_TENANT.has(t.name));
      if (GLOBAL_WITH_TENANT.has(t.name)) continue;
      const required = APPEND_ONLY.has(t.name)
        ? ["id", "created_at"]
        : ["id", "created_at", "updated_at", "row_version"];
      for (const c of required) expect(cols.has(c), `${t.name}.${c}`).toBe(true);
    }
  });

  it("RLS is enabled and forced with a tenant policy on every tenant table", async () => {
    const policies = new Set(
      (await q<{ tablename: string }>(`SELECT tablename FROM pg_policies WHERE schemaname = 'public'`)).map(
        (r) => r.tablename,
      ),
    );
    for (const t of await parentTables()) {
      const cols = await columnsOf(t.name);
      if (!cols.has("tenant_id") && t.name !== "tenant") continue;
      if (NO_RLS.has(t.name)) continue;
      expect({ table: t.name, rls: t.rls, force: t.force, policy: policies.has(t.name) }).toEqual({
        table: t.name,
        rls: true,
        force: true,
        policy: true,
      });
    }
  });

  it("every foreign key to a tenant table is composite and starts with tenant_id", async () => {
    const fks = await q<{
      name: string;
      child: string;
      parent: string;
      cols: string[];
      set_null_cols: string[] | null;
      action: string;
    }>(`
      SELECT con.conname AS name, child.relname AS child, parent.relname AS parent,
             array(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS cols,
             CASE WHEN con.confdelsetcols IS NULL THEN NULL ELSE
               array(SELECT a.attname FROM unnest(con.confdelsetcols) k(n)
                     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n)::text[] END AS set_null_cols,
             con.confdeltype AS action
        FROM pg_constraint con
        JOIN pg_class child ON child.oid = con.conrelid
        JOIN pg_class parent ON parent.oid = con.confrelid
       WHERE con.contype = 'f' AND NOT child.relispartition AND con.conparentid = 0`);
    const tenantTables = new Set<string>();
    for (const t of await parentTables()) if ((await columnsOf(t.name)).has("tenant_id")) tenantTables.add(t.name);
    expect(fks.length).toBeGreaterThan(50);
    for (const fk of fks) {
      if (fk.parent === "tenant" || !tenantTables.has(fk.parent)) continue; // global parent
      expect(fk.cols[0], `${fk.name} must start with tenant_id`).toBe("tenant_id");
      if (fk.name === "listing_price_change_listing_fk") {
        expect(fk.cols).toEqual(["tenant_id", "listing_id", "store_id"]);
      } else expect(fk.cols.length, `${fk.name} must be composite`).toBe(2);
      if (fk.action === "n") {
        // ON DELETE SET NULL must name the column, or PostgreSQL would null tenant_id as well
        expect(fk.set_null_cols, `${fk.name} SET NULL column list`).toEqual([fk.cols[1]]);
      }
    }
  });

  it("every partitioned table is maintained and has a default partition", async () => {
    const partitioned = (await parentTables())
      .filter((t) => t.kind === "p")
      .map((t) => t.name)
      .sort();
    const targets = (await q<{ table_name: string }>("SELECT table_name FROM partition_targets()"))
      .map((r) => r.table_name)
      .sort();
    expect(partitioned).toEqual(targets);
    for (const t of partitioned) {
      const d = await q(
        `SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                          WHERE i.inhparent = $1::regclass AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`,
        [`"${t}"`],
      );
      expect(d.length, `${t} default partition`).toBe(1);
    }
  });

  it("no application role has privileges on a partition", async () => {
    const leaks = await q(`SELECT c.relname, g.rolname FROM pg_class c
                             JOIN LATERAL aclexplode(c.relacl) a ON true
                             JOIN pg_roles g ON g.oid = a.grantee
                            WHERE c.relispartition AND g.rolname LIKE 'omniseller\\_%' AND g.rolname <> 'omniseller_migrator'`);
    expect(leaks).toEqual([]);
  });

  it("status CHECK lists match the shared status constants", async () => {
    const check = async (table: string) => {
      const [row] = await q<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE 'CHECK ((status = ANY%'`,
        [`"${table}"`],
      );
      return [...row!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    };
    expect(await check("order")).toEqual([...ORDER_STATUSES].sort());
    expect(await check("shipment")).toEqual([...SHIPMENT_STATUSES].sort());
    expect(await check("sync_job")).toEqual([...SYNC_JOB_STATUSES].sort());
    expect(await check("document_job")).toEqual([...DOCUMENT_JOB_STATUSES].sort());
    expect(await check("data_export")).toEqual([...DATA_EXPORT_STATUSES].sort());
    expect(await check("migration_job")).toEqual([...MIGRATION_JOB_STATUSES].sort());
    expect(await check("store_cutover")).toEqual([...STORE_CUTOVER_STATUSES].sort());
    expect(await check("print_job")).toEqual([...PRINT_JOB_STATUSES].sort());
    expect(await check("handover")).toEqual([...HANDOVER_STATUSES].sort());
    expect(await check("listing_copy")).toEqual([...LISTING_COPY_STATUSES].sort());
    expect(await check("listing_draft")).toEqual([...LISTING_DRAFT_STATUSES].sort());
    expect(await check("listing_price_change")).toEqual([...LISTING_PRICE_CHANGE_STATUSES].sort());
    expect(await check("return_request")).toEqual([...RETURN_REQUEST_STATUSES].sort());
    expect(await check("stock_count")).toEqual([...STOCK_COUNT_STATUSES].sort());
    expect(await check("stock_transfer")).toEqual([...STOCK_TRANSFER_STATUSES].sort());
    expect(await check("subscription")).toEqual([...SUBSCRIPTION_STATUSES].sort());
    expect(await check("invoice")).toEqual([...INVOICE_STATUSES].sort());
  });

  it("every transition uses known statuses", async () => {
    for (const [table, statuses] of [
      ["order_status_transition", ORDER_STATUSES],
      ["shipment_status_transition", SHIPMENT_STATUSES],
      ["sync_job_status_transition", SYNC_JOB_STATUSES],
      ["document_job_status_transition", DOCUMENT_JOB_STATUSES],
      ["data_export_status_transition", DATA_EXPORT_STATUSES],
      ["migration_job_status_transition", MIGRATION_JOB_STATUSES],
      ["store_cutover_status_transition", STORE_CUTOVER_STATUSES],
      ["print_job_status_transition", PRINT_JOB_STATUSES],
      ["handover_status_transition", HANDOVER_STATUSES],
      ["listing_copy_status_transition", LISTING_COPY_STATUSES],
      ["listing_draft_status_transition", LISTING_DRAFT_STATUSES],
      ["listing_price_change_status_transition", LISTING_PRICE_CHANGE_STATUSES],
      ["return_request_status_transition", RETURN_REQUEST_STATUSES],
      ["stock_count_status_transition", STOCK_COUNT_STATUSES],
      ["stock_transfer_status_transition", STOCK_TRANSFER_STATUSES],
      ["subscription_status_transition", SUBSCRIPTION_STATUSES],
      ["invoice_status_transition", INVOICE_STATUSES],
    ] as const) {
      const rows = await q<{ from_status: string; to_status: string }>(`SELECT from_status, to_status FROM ${table}`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(statuses).toContain(r.from_status);
        expect(statuses).toContain(r.to_status);
      }
    }
  });

  it("seeded permissions equal the shared permission list", async () => {
    const codes = (await q<{ code: string }>("SELECT code FROM permission ORDER BY code")).map((r) => r.code);
    expect(codes).toEqual([...PERMISSION_CODES].sort());
  });

  it("status machines have their trigger with the base table as argument", async () => {
    const rows = await q<{ tbl: string; def: string }>(`
      SELECT c.relname AS tbl, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'status_transition_trg' AND NOT c.relispartition ORDER BY 1`);
    expect(rows.map((r) => r.tbl)).toEqual([
      "data_export",
      "document_job",
      "handover",
      "invoice",
      "listing_copy",
      "listing_draft",
      "listing_price_change",
      "migration_job",
      "order",
      "print_job",
      "return_request",
      "shipment",
      "stock_count",
      "stock_transfer",
      "store_cutover",
      "subscription",
      "sync_job",
    ]);
    for (const r of rows) expect(r.def).toContain(`enforce_status_transition('${r.tbl}')`);
  });
});

describe("tenant purge (backend doc 8.36)", () => {
  const order = async () =>
    q<{ table_name: string; depth: number }>("SELECT table_name, depth FROM tenant_purge_order()");

  it("walks every table holding a business's rows, but the tax records and the outbox", async () => {
    const withTenant = await q<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`,
    );
    const kept = (await q<{ t: string[] }>("SELECT tenant_kept_tables() AS t"))[0]!.t;
    expect(kept).toEqual(["invoice", "subscription"]);
    expect((await order()).map((r) => r.table_name).sort()).toEqual(
      withTenant
        .map((r) => r.name)
        .filter((t) => ![...kept, "outbox_event"].includes(t))
        .sort(),
    );
  });

  it("deletes every referencing table before the table it references", async () => {
    const depth = new Map((await order()).map((r) => [r.table_name, r.depth]));
    const edges = await q<{ child: string; parent: string }>(
      `SELECT k.conrelid::regclass::text AS child, k.confrelid::regclass::text AS parent FROM pg_constraint k
        WHERE k.contype = 'f' AND k.conrelid <> k.confrelid AND k.confdeltype IN ('a', 'r', 'c')`,
    );
    const late = edges
      .map((e) => ({ child: e.child.replaceAll('"', ""), parent: e.parent.replaceAll('"', "") }))
      .filter((e) => depth.has(e.child) && depth.has(e.parent))
      .filter((e) => depth.get(e.child)! >= depth.get(e.parent)!);
    expect(late).toEqual([]);
    // the graph has no cycle: the deepest chain is shorter than the number of tables
    expect(Math.max(...depth.values())).toBeLessThan(depth.size);
  });

  it("finds each table's rows by an index leading with tenant_id", async () => {
    const unindexed = await q<{ table_name: string }>(
      `SELECT o.table_name FROM tenant_purge_order() o
         JOIN pg_class c ON c.relname = o.table_name AND c.relnamespace = 'public'::regnamespace
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
           WHERE i.indrelid = c.oid AND a.attname = 'tenant_id' AND i.indpred IS NULL)`,
    );
    expect(unindexed).toEqual([]);
  });

  it("refuses a business that is not closed and past its purge date, and only the worker may call it", async () => {
    const worker = await h.raw("worker");
    const api = await h.raw("api");
    try {
      const nobody = "01JZZZZZZZZZZZZZZZZZZZZZZZ";
      expect((await worker.query("SELECT begin_tenant_purge($1) AS go", [nobody])).rows[0].go).toBe(false);
      await expect(worker.query("SELECT purge_tenant_step($1, 'product', 10)", [nobody])).rejects.toThrow(
        /TENANT_NOT_PURGEABLE/,
      );
      expect((await worker.query("SELECT finish_tenant_purge($1) AS done", [nobody])).rows[0].done).toBe(false);
      await expect(api.query("SELECT begin_tenant_purge($1)", [nobody])).rejects.toThrow(/permission denied/);
    } finally {
      await worker.end();
      await api.end();
    }
  });
});
