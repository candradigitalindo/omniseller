# AGENTS.md — OmniSeller

Read first: `DOKUMEN-ARSITEKTUR-BACKEND.md` section 2 (contract), then the section for your task type (table 2.3).
Product requirements: `DOKUMEN-SPESIFIKASI-APLIKASI.md`. Technology decisions and ADRs: `DOKUMEN-TEKNOLOGI.md`.

The repository root holds only documents. Each component lives in its own folder with its own pnpm workspace:
`backend/` exists now; `frontend/`, `mobile/`, `extension/`, `print-agent/` come later (ADR-032).
Paths in the backend document are relative to `backend/`, and every `pnpm` command below runs from `backend/`.

## Non-negotiable invariants (backend)
- All tenant data access goes through `withTenantTx(handle, ctx, fn)`. Never query outside it.
- Stock quantities change only via `apply_stock_movement()` (and `ensure_inventory()` for the zero row). The app roles have no write privilege on quantities; do not try to work around it.
- Status changes are enforced by DB triggers against `<table>_status_transition`. Marketplace-reported facts that skip seller steps run inside `withStatusSource(tx, "marketplace", fn)`.
- Side effects (marketplace, email, WhatsApp, AI) are emitted with `outbox.enqueue(tx, ctx, event, payload, aggregateId)` and executed by jobs. No `queue.add()` from services, no HTTP calls from the api process.
- Job ids come from `jobKey(...)` (separator `|`; BullMQ rejects `:`). Actions that may recur for the same entity include the outbox event id or another occurrence key in the id.
- Every tenant table: `ulid` id, `tenant_id`, `created_at`, `updated_at`, `row_version`; every FK to a tenant table is composite `(tenant_id, x_id)`; `ON DELETE SET NULL (x_id)` always names the column.
- Money is bigint rupiah (`money()` column, `rupiah()` in code). Ids are ULID strings from `newId()` (records timed by a marketplace, such as orders: `newIdAt(time)`). Times are UTC `timestamptz`.
- Buyer PII never appears in logs (use `logger` from `@omniseller/logging`, never `console`), in the research schema, or in AI prompts without scrubbing.
- Schema changes follow expand-and-contract. Applied migrations are never edited.

## Commands (from `backend/`)
```
pnpm install
pnpm infra:up            # Docker; or: pnpm infra:native start (no Docker)
cp .env.example .env.local
pnpm db:bootstrap && pnpm db:migrate
pnpm dev                 # api, webhook, worker, scheduler
pnpm lint && pnpm typecheck && pnpm test
pnpm test:int            # needs TEST_PG_ADMIN_URL + TEST_REDIS_URL, or Docker for Testcontainers
```

## Where things are (under `backend/`)
- `drizzle/migrations/NNNN_name.sql`: versioned DDL, run once (source of truth for constraints)
- `drizzle/sql/*.sql`: repeatable, idempotent: functions, triggers, RLS policies, grants, seeds
- `src/db/schema/<domain>.ts`: Drizzle mirror of the SQL (typed queries); `test/schema` keeps both in sync
- `src/modules/<name>/`: business modules (controller, service, repository, events, errors, dto, README)
- `src/jobs/`: `defineEvent`, `defineJob`, `jobKey`, registry; a module's jobs live in `src/modules/<name>/<name>.jobs.ts` and are added to `jobs/registry.ts`; `src/scheduler/`: relay and loops
- `src/common/security/`: passwords, secret tokens, Redis sessions, rate limiter; `src/modules/auth/auth.guard.ts`: the global guard that builds `RequestContext`
- `packages/shared/src`: ULID, money, permissions, statuses; `packages/logging`: the logger
- `packages/connectors/<marketplace>`: marketplace clients (no database); `src/modules/channel/marketplace-gateway.ts` is how the worker calls them
- `src/modules/files/`: private files (`FilesService`, `FileStorage`: R2, MinIO via `R2_ENDPOINT`, or a local directory in local/test); `src/modules/fulfillment/pdf.ts`: PDFs with pdf-lib and the bundled Noto Sans in `assets/fonts`
- `src/modules/reporting/`: the home dashboard and the sales report (read through the owning modules' services; `sales-report-plan.ts`: periods and comparison) and the daily operational email (`digest.service.ts`, worker only, owns `daily_digest`); `src/modules/exports/`: the full data export (ZIP of CSVs); `src/modules/notification/inbox.service.ts`: in-app notifications (`notifyScopedIn`); `preferences.service.ts`: each user's notification choices
- `src/modules/inventory/restock.service.ts`, `restock-plan.ts`: the restock list (sales per day per variant and warehouse, days of cover, suggested order)
- `src/common/csv.ts`: CSV for spreadsheets; `src/common/time-zone.ts`: dates in the business's time zone; `src/common/export-sheet.ts`: `ExportSheet`, one per exported table
- `src/modules/migration/`: imports from other apps (`import-plan.ts`: fields, per-app header synonyms, row conversion; `sheet.ts`, `xlsx.ts`: file readers), parallel mode and cutover; `src/modules/inventory/stock-comparison.service.ts`: marketplace stock against what OmniSeller would send
- `test/setup/mock-marketplace.ts`: fake Shopee and TikTok Shop that enforce the documented signatures and token rules, including order packages, arranging shipment, tracking numbers, and label PDFs

## How to add things
Module: section 15.4. Table: 15.5 (write the SQL migration first, then the Drizzle mirror). Endpoint: 15.6. Job: 15.7. Connector: 15.8. Event: 15.9.
NestJS injection always uses explicit `@Inject(TOKEN)`; do not rely on constructor type metadata.

## Traps that already bit this codebase
- DTO classes used in `@Body()`, `@Query()`, `@Param()` must be imported as values, never with `type`. A type-only import erases the class from decorator metadata and every request to that route fails with 500 (`ZodSchemaDeclarationException`). `src/common/http/dto-metadata.spec.ts` checks every controller; add new controllers to its list. Biome's `useImportType` is off for this reason.
- Every endpoint declares `@Isolation(...)` or `@Public()`; the generator in `test/tenant-isolation` fails otherwise. A new fixture kind or mutating operation needs an entry there.
- Inside a Drizzle `sql` subquery, reference the outer table's columns fully qualified (`sql.raw('"user"."id"')`). In a single-table select Drizzle renders `${user.id}` as a bare `"id"`, which binds to the subquery's own table.
- Raw `tx.execute(sql...)` returns `timestamptz` as strings; use the query builder when you need `Date`.
- Endpoints that must work before a tenant is known (login, webhooks, token links) go through the `SECURITY DEFINER` lookups in `PreTenantLookup`, never around RLS.
- Marketplace JSON goes through `parseJsonSafe` (`@omniseller/connector-core`), never plain `JSON.parse`: TikTok Shop product ids have 19 digits and lose precision as numbers. The webhook receiver already lost an id this way once.
- Marketplace calls go only through `MarketplaceGateway.call`; the per-shop rate limit is taken per HTTP request inside it (`withRequestGate`), so a connector method may page as much as it needs.
- Listing pulls page in batches (`PAGES_PER_JOB`) and continue through an outbox event; do not loop over a whole catalog in one job.
- Stock changes go through `InventoryService` (`adjust`, `establishIn`, later the order and return movements), which writes `inventory.changed` in the same transaction. A movement without that event never reaches the marketplaces.
- Stock nobody has established (`inventory.stock_set_at` null) is never pushed (ADR-036). A count equal to the record must still be confirmed: a `set` adjustment with no difference calls `confirm_stock`.
- `InventoryModule` lives in `inventory-core.module.ts` and must not import catalog or channel: channel imports it, and a cycle between module files hands Nest an undefined import ("Nest cannot create the ... module instance"). Features that need listings, stores, or orders go in `inventory.module.ts`.
- Marketplace orders go through `OrderIntakeService.applyIn` only. It ignores snapshots older than `external_updated_at`, never moves a status backwards, and derives stock from the status (`itemStockPlan`): only reserved units ship. Order ids come from `newIdAt(ordered_at)`, not `newId()`.
- Orders reserve stock even in read-only stores (parallel mode counts stock); only the push pauses there. Seller actions on orders (accept, pack, cancel) are refused for read-only stores.
- Never hold a database transaction open across an HTTP call to a marketplace: the worker role ends sessions idle in a transaction after 10 seconds. Call marketplaces only through `MarketplaceGateway` (rate limit, sync log, token refresh); for a lock that must span the call use `withAdvisoryLock`.
- Shipping labels and printed documents carry buyer names, phones, and addresses. Store them only through `FilesService` (private, with `expires_at`) and never log their bytes or URLs; connectors download files with `requestFile`, which records only size and type.
- Upload a file before writing its row (`FilesService.save` does): never keep a database transaction open across an upload to R2.
- Fulfillment changes orders only through `OrderIntakeService` (`advanceIn`, `recordIn`, `setShippingIn`); shipments follow orders through the `order.status_changed` event, never by reading order tables.
- `label.fetch` throws `LabelsPendingError` on purpose while the courier's tracking number or the marketplace's label is not there yet, so BullMQ retries with backoff. Do not catch it.
- Webhook signatures cover the exact raw body. The webhook process parses no JSON before verifying (`webhook/webhook-app.ts`); do not add a JSON body parser there.
- `outbox.enqueue` writes nothing for an event that no job consumes yet, so a test cannot look for that event's row.
- Test servers must listen on 127.0.0.1 before supertest uses them (`listenOnLoopback` in `test/setup/app.ts`). Left to supertest they bind `::` on a random port, and on macOS an editor helper holding the same port on 127.0.0.1 then answers some test requests (401s in another API's error format).
- Marketplace shop ids in e2e files must not overlap between files (`let shopSeq` per file): `store (channel, external_shop_id)` is unique across tenants and the files share one database.
- Tests that touch BullMQ use the run's prefix (`infra.keyPrefix`, passed by `startApi`, `startWorker`, `startWebhook`); jobs under the default `bull` prefix would reach any worker sharing the Redis.
- In the Indonesian market the TikTok Shop channel is shown as "Tokopedia & Shop" (platform branding rule, PRD 5.6); the internal channel id stays `tiktokshop`.
- On a partitioned table `TG_TABLE_NAME` is the partition (`stock_movement_p202610`). Audit triggers there pass the table name: `audit_row('stock_movement')`; otherwise `audit_log.entity_type` holds the partition and nobody finds the entry.
- A Drizzle `sql` fragment with a parameter (`AT TIME ZONE ${tz}`) used in SELECT, GROUP BY, and ORDER BY binds a new parameter each time, and Postgres treats them as different expressions (42803). Group and order by position (`` sql`1` ``).
- A table holding tenant business data needs an `ExportSheet` in its owning service, listed in `ExportRenderService.sheets()`. Without one the full export (FR-MIG-09) silently leaves it out.
- CSV meant for spreadsheets goes through `common/csv.ts` (`;`, BOM, CRLF, a `'` before text starting with `=`, `+`, `-`, `@`): buyer names and notes are written by strangers.
- Notifications go through `NotificationInboxService.notifyScopedIn`: recipients are users holding the permission, and each hears only about stores and warehouses in their scope.
- Keep `requestChecksumCalculation: "WHEN_REQUIRED"` on the S3 client (`files/file-storage.ts`): with the SDK default a streamed upload reaches storage `aws-chunked` with a CRC32 trailer, which R2 does not document.
- A user with no stores listed in `user_store_scope` sees every store (`storeScope` null). To limit a user, list the stores; `storeIds: []` removes the limit.
- Read uploaded spreadsheets only through `migration/sheet.ts` (`readSheet`): it decides the type from the content, caps what an .xlsx may unzip to (a 200 KB file can expand to gigabytes), and keeps blank rows so row numbers match what the seller sees.
- The web app moves a store live through the cutover (`POST /v1/migration/cutover`), which checks the checklist (listings mapped, stock equal, old app revoked) and can be undone for 24 hours. `PATCH /v1/stores/{id} {syncMode}` skips the checklist; it stays for API clients and for going back to read-only.
- Sales are orders neither `unpaid` nor `cancelled`, counted by `ordered_at` in the tenant's time zone (PRD 13.2). Use `OrdersService.salesIn` and its siblings (`salesBucketsIn`, `salesByIn`, `itemSalesIn`) instead of a new definition, so the dashboard, the sales report, and the daily email agree.
- Group by position when the grouped expression binds a parameter, such as the time zone (``groupBy(sql`1`)``): PostgreSQL treats each mention of a parameter as a different expression and fails with 42803.
- `NotificationInboxModule` must not import orders, inventory, or channel, because they import it. A feature that combines them, such as the daily email, lives with the module that reads them (`ReportingWorkerModule`).
- Imports write through `ProductTransferService.importRecordsIn` and `InventoryService.importInitialIn` in the caller's transaction and return problems instead of throwing; with any problem the caller must roll back, because some rows may already be written.

## Definition of done
Tests per section 13.3 (integration tests run as the application roles, never as a superuser), migration checklist 12.3, docs updated (module README and the backend doc section you touched), PR checklist 15.11.
