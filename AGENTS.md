# AGENTS.md — OmniSeller

Read first: `DOKUMEN-ARSITEKTUR-BACKEND.md` section 2 (contract), then the section for your task type (table 2.3).
Product requirements: `DOKUMEN-SPESIFIKASI-APLIKASI.md`. Technology decisions and ADRs: `DOKUMEN-TEKNOLOGI.md`.

The repository root holds only documents. Each component lives in its own folder with its own pnpm workspace:
`backend/` and `frontend/` exist now; `mobile/`, `extension/`, `print-agent/` come later (ADR-032).
Paths in the backend document are relative to `backend/`, and every `pnpm` command below runs from `backend/` unless a section says otherwise.

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
- `src/modules/inventory/warehouse-admin.service.ts`: adding, changing, and deleting warehouses; `allocation-plan.ts` with `InventoryService.allocateIn`: the nearest warehouse that has every item (FR-ORD-12); `src/common/region.ts`: Indonesian provinces and island groups
- `src/modules/inventory/stock-count.service.ts` (stock counts, applied by job `stock_count.apply`), `stock-transfer.service.ts` (transfers between warehouses), their tables through `stock-ops.repository.ts`, pure rules in `stock-ops-plan.ts`; stock moves through `InventoryService.countMovementsIn` and `transferMovementsIn` (backend doc 8.27)
- `src/modules/orders/manual-orders.service.ts`: manual orders (FR-ORD-09) in stores of channel `manual`; `tags.service.ts`: order tags; `src/modules/fulfillment/pdf.ts` `renderManualLabel`: their labels
- Parcel tracking (FR-SHP-07): `FulfillmentWorkerService.pullTracking` (job `shipment.tracking_pull`), `src/scheduler/tracking-scan.ts`, connector `fulfillment.tracking`; kept on `shipment.tracking_*`. `src/modules/fulfillment/label-template.service.ts`: the custom label template (FR-SHP-16); `pdf.ts` `composeLabels` (template strip) and `renderPackingList` (FR-SHP-03)
- `src/modules/retention/`: deleting data that is not kept (`StoreDataDeletionService`: a store disconnected without its data, through the owning modules' services); `src/common/barcode.ts`: GS1 check digits, `barcodeProblem`, internal EAN-13 numbers, EAN-13/EAN-8/Code 128 bars; `src/modules/catalog/product-history.ts`: product history entries from the audit log
- `src/common/document-number.ts` (`nextDocumentNumber`, table `document_sequence`) and `src/common/idempotency.ts` (`claimIdempotencyKey`, table `idempotency_record`): shared helpers, used inside the creating transaction
- `src/common/csv.ts`: CSV for spreadsheets; `src/common/time-zone.ts`: dates in the business's time zone; `src/common/export-sheet.ts`: `ExportSheet`, one per exported table
- `src/modules/migration/`: imports from other apps (`import-plan.ts`: fields, per-app header synonyms, row conversion; `sheet.ts`, `xlsx.ts`: file readers), parallel mode and cutover; `src/modules/inventory/stock-comparison.service.ts`: marketplace stock against what OmniSeller would send
- `src/modules/listing-copy/`: copying listings between the seller's stores, a whole store at once, through reviewed drafts (FR-PRD-13, backend doc 8.25): `ListingCopyService` (copies, drafts, publish), `CategoriesService` and `CategorySyncService` (per-store category cache and rules), `CopyWorkerService` (prepare, recheck, publish); decisions in `copy-plan.ts`, image downloads in `image-fetch.ts`; connector part `products` in `packages/connectors/*/src/products.ts`
- `test/setup/mock-marketplace.ts`: fake Shopee and TikTok Shop that enforce the documented signatures and token rules, including order packages, arranging shipment, tracking numbers, and label PDFs; `test/setup/mock-products.ts`: their product creation (categories, attributes, brands, multipart image uploads, `add_item` with `init_tier_variation`, Create Product) and image hosting (`/img/...`)
- `src/realtime/`: `RealtimeGateway` (Socket.IO on the api's HTTP server, Redis adapter, device-token handshake) and `REALTIME` (Redis emitter every process uses: `toDevice`, `disconnectDevice`)
- `src/modules/fulfillment/`: `print.service.ts` (print jobs and the agent's routes), `print-agents.service.ts` (pairing, printers, revoking, test page), `scan.service.ts` (`orderIn`: the order behind a scanned order or tracking number), `packing.service.ts`, `handover.service.ts`, and their pure rules in `scan-plan.ts`; `src/modules/identity/devices.service.ts`: device rows and tokens
- `src/common/cost-visibility.ts`: `seesCost(ctx)`, who may see cost prices
- `src/modules/returns/`: buyers' returns, refunds, and cancellation requests, and parcels of orders cancelled after shipping (RTO): `ReturnsService` (lists, decisions, evidence photos, receipts into stock or quarantine), `ReturnSyncService` (worker: pulls, decisions, sending them, RTO), `ReturnAlertsService`, pure rules in `return-plan.ts`; connector part `returns`; `test/setup/mock-returns.ts`: the fake marketplaces' return APIs

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
- `NotificationInboxModule` must not import orders, inventory, or channel, because they import it. A feature that combines them, such as the daily email, lives with the module that reads them (`ReportingWorkerModule`).
- Manual sales channels are stores with channel `manual`: no marketplace, credentials, listings, or webhooks behind them. Anything that walks stores to call a marketplace or queue marketplace jobs skips them (`isManualChannel`), as `scheduler/channel-scans.ts` does; marketplace-only endpoints answer 422 `store.manual`.
- Orders OmniSeller creates (manual orders) go through `OrderIntakeService.createIn`, marketplace orders through `applyIn` only. A manual order walks every seller step (`pathTo`) and never uses `withStatusSource(tx, "marketplace")`.
- Warehouses change only through `WarehouseAdminService` (signup's first warehouse is the exception): deleting one checks stock, open orders, stores' default warehouses, and marketplace mappings, and its code stays taken.
- A request that creates a record with an `Idempotency-Key` claims the key with `claimIdempotencyKey` inside the creating transaction, before writing. Do not keep responses or bodies in Redis for this: they hold buyer data.
- Every Shopee push code `parseShopeePush` reads (`SHOPEE_PUSH_KINDS`) must also be in `SHOPEE_SUBSCRIBED_PUSH_CODES`, or Shopee never sends it. Code 15 (shipping document ready) was missed this way; a connector test now checks the two lists.
- Work nobody waits for (parcel tracking) calls `MarketplaceGateway.call(..., { background: true })` and runs on its own queue (`mp.track`): it then takes at most 30% of the store's request rate, so stock pushes and order work keep the rest. A connector loop over many orders stops at a temporary failure and returns what it read; do not store a temporary failure as the order's error.
- Tracking is for display: `shipment.tracking_*` never moves an order or shipment status, which follow the marketplace's order status. Event descriptions may name who received the parcel, so they are personal data: never log them (the sync log keeps counts only).
- The custom label template adds a strip under a marketplace label (`composeLabels` with `strip`) and scales the label into the space above it. Never draw over the marketplace label itself: its required parts must stay intact (FR-SHP-16).
- A disconnected store keeps its row, even when its data is deleted: `user_store_scope` references stores with CASCADE, and a user whose only scoped store disappeared would end up with no scope rows, which means every store. Shop uniqueness is a partial index (`status <> 'disconnected'`); find a store by marketplace shop id through `resolve_store` or `ChannelRepository.storeByExternalId`, which prefer the store in use.
- Open orders of a disconnected store hold no stock (`order.store_disconnected` released it). Paths that re-plan an order's stock (`attachListingIn`, `recheckStockIn`) skip disconnected stores; a new one must do the same, or the stock comes back as reserved for orders nothing will ship.
- Drizzle turns a JS array inside a `sql` template into a parenthesized list (`($1, $2)`), not a Postgres array: `= ANY(${ids})` and `${ids}::text[]` fail. Use `inArray`, or `ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]`.
- A notification that must also go by email: `notifyScopedIn(..., { email: true })`; the job `notification.email` sends it and records `channels_sent.email`. Do not send emails from the deciding job.
- Imports write through `ProductTransferService.importRecordsIn` and `InventoryService.importInitialIn` in the caller's transaction and return problems instead of throwing; with any problem the caller must roll back, because some rows may already be written.
- The api process never calls a marketplace, so anything a screen needs from one (categories, attribute rules) is a cache the worker fills (`channel_category`), and the api queues the read. Brands are looked up by the worker when a draft is prepared or published.
- Product images go to marketplaces only after `fetchImage` (`listing-copy/image-fetch.ts`): marketplace image hosts plus `PRODUCT_IMAGE_HOSTS`, https, redirects re-checked, 10 MB, type from the bytes. Never fetch a URL from a marketplace answer with plain `fetch`.
- Shopee has no idempotency key: keep the item id from `products.create`'s `hooks.itemCreated` at once, and pass it back as `resume`, or a retry creates a second item. TikTok Shop's Create Product key is `<draft_id>-<publish_attempt>`: the same key for BullMQ retries, a new one after the seller edits a failed draft.
- TikTok Shop signs multipart requests without their body (`TiktokShopClient.upload`); Shopee signs the URL only. Both upload bodies go through `fileForm`, so the sync log keeps the file's size and type, not its bytes.
- `withAdvisoryLock` holds a pool connection for as long as the lock is held, and the worker's pool has 10 connections. Never hold it around long work that runs concurrently (ten `mp.outbound` jobs exhausted the pool and every query inside them waited forever): claim the row instead (`listing_draft.publishing_started_at`, renewed per step, taken over after its lease).
- `idempotency_record.scope` must look like `area.action` (CHECK `^[a-z_]+(\.[a-z_]+)+$`): `listing_copy.create`, `order.manual`. A scope without a dot fails with `row.constraint_failed`.
- `timestamptz` has microseconds and a JS `Date` milliseconds: comparing a column for equality with a `Date` read from it never matches. Compare in SQL (`= (SELECT created_at FROM ...)`).
- Shopee's `tier_variation` structure is deprecated since 2025-09-12: `init_tier_variation` takes `standardise_tier_variation` (`variation_id` 0 for custom variations). TikTok Shop SEA shops pass `category_version=v2` to every category, attribute, brand, and Create Product call.

- A stock count line keeps the on-hand quantity of the moment it was counted (`expected_qty`); applying moves stock by the count's difference against it (`countApplyDelta`), never to the counted number, so what sold or arrived after the count stays. Counted lines are written with one upsert per variant in variant order while the count is held `FOR SHARE`; two counters scanning one shelf add up.
- A join of `inventory` (or another per-variant table) with `catalog_variant_v` can go wrong right after a bulk import: before autovacuum analyzes the new rows, the planner thinks the tenant has one variant and picks a nested loop over every stock row of the warehouse per variant (7.3 s for 12,000 SKUs, past the 5-second statement timeout). New queries over many variants read one table and fetch the rest by key (`inArray` in chunks of 1,000), as `StockOpsRepository` does; a smoke run with `ALTER TABLE ... SET (autovacuum_enabled = false)` on the scratch database shows whether a query survives stale statistics.
- Transfer movements (`transfer_out`, `transfer_in`) never establish stock (ADR-036). Units that did not arrive are recorded on the transfer line only: they already left with `transfer_out`, and an adjustment would take them twice.

- Print agent routes take `@DeviceRoute("print_agent")` (a Bearer device token, never the session cookie) and `@Isolation({ fixture, actor: "device" })`, so the isolation generator calls them with tenant B's agent token. A route that acts only on the calling agent is `"self"`.
- Push to agents only after the commit: call `PrintService.push(jobs)` once `withTenantTx` has returned, because an agent can download before an uncommitted row is visible. Publish through `REALTIME` from any process; do not create other Socket.IO servers or emitters.
- Do not call Socket.IO's `io.close()` on shutdown: it closes Nest's HTTP server, which Nest closes itself after the hooks. The gateway closes its connections and adapter only.
- Cost prices, stock value, and gross profit need `finance:read`. A new view showing HPP, or a number derived from it, goes through `seesCost(ctx)` and returns `null` without it.
- No `Promise.all` over queries inside one transaction: await them one by one. A pg client runs one query at a time anyway, pg 8.23 deprecates overlapping `client.query` (a DeprecationWarning in every process), and pg 9 will throw. The last such places were removed in M14.
- Locking both a shipment and its order (courier handover): lock shipments first, then orders, the same order the worker's `followOrder` uses.
- A print job may exist before its file: it waits for its document (`document_id`) until the worker attaches the file, and `print_job.file_object_id` is SET NULL when the file expires.

- A versioned migration cannot call `gen_ulid()` or anything else from `drizzle/sql/`: on a fresh database the repeatable files run after every migration. Data changes that need them go in `90_seeds.sql`, idempotent; a new permission reaches the built-in roles of existing businesses there, because built-in roles never change after signup (new businesses copy `SYSTEM_ROLES`).
- What a seller may decide on a return is read by the worker into `return_request.decisions`, valid only for `decisions_for` (the marketplace status it was read for). The api refuses a decision while they are stale (409 `return.decisions_stale`); it never asks the marketplace itself.
- Reading decisions claims the rows first (`decisions_claimed_at`, `FOR UPDATE SKIP LOCKED`, taken over after 5 minutes). Without the claim, pulls and continuations running together read the same requests again: the smoke run read every request four times.
- A burst of orders entering TO_RETURN shares one `return.pull`: the job id comes from the event's `at` per 10 seconds, the job waits 10 seconds, and a pull whose returns cursor is newer than `at` stops. A new event that makes a per-store marketplace read should coalesce the same way.
- Receiving returned goods locks the order before the stock rows, as order changes do, then moves stock through `InventoryService.returnMovementsIn`; order lines count returned units only through `OrderIntakeService.returnReceivedIn`.
- A Shopee buyer's cancellation request has no id of its own: its `external_return_id` is the order_sn, kept apart from return ids by `(kind = 'cancellation')` in the unique index.
- Shopee return snapshots carry the buyer's email and pickup address: connectors never read those fields. The buyer's reason text and photos stay out of logs and of the audit log (`audit_row` skips those columns).

- `nestjs-zod@5.5.0` is patched (`patches/nestjs-zod@5.5.0.patch`): it wrote nullable fields as `type: ["string", "null"]` with one type's keywords, which generated clients misread; the patch turns them into `anyOf`. Upgrading nestjs-zod means redoing or dropping the patch; `test/tenant-isolation/isolation.int.spec.ts` checks the shape.
- A response declared without a status comes out of `@nestjs/swagger` as `default`, which openapi-fetch types as the error. `buildOpenApiDocument` renames it to the handler's real status (`@HttpCode`, else 201 for POST and 200 otherwise); a handler that answers another status must say so with `@HttpCode`.

## Frontend (`frontend/`, commands from there)
- Read `frontend/README.md` (structure, rules, traps). Next.js 16 differs from older versions: `frontend/AGENTS.md` points to the guides in `node_modules/next/dist/docs/`.
- `pnpm dev` (port 3100, `/v1/*` forwarded to `API_ORIGIN`), `pnpm lint && pnpm typecheck && pnpm test`, `pnpm build`.
- API types are generated from `backend/openapi.json`: after a contract change run `pnpm openapi:emit` in `backend/`, then `pnpm api:types` here. Never write response types by hand.
- Every call goes through `api` and `unwrap` (`src/lib/api/client.ts`); UI text lives only in `messages/id.json`; dates use the business's time zone (`useTimeZone`); actions without permission are hidden (`useCan`).
- Buyer data never goes to `console`, `localStorage`, or URLs.
- Seller actions on a read-only store's orders and returns are refused (409 `store.read_only`): screens hide them with `useStores().readOnly(storeId)` and say where to act instead.
- Scans go through `ScanBuffer` (one request per code with its quantity): a request per scanned unit spends the business's 600 requests a minute.

## Definition of done
Tests per section 13.3 (integration tests run as the application roles, never as a superuser), migration checklist 12.3, docs updated (module README and the backend doc section you touched), PR checklist 15.11.
