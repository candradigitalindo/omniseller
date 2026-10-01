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
- Money is bigint rupiah (`money()` column, `rupiah()` in code). Ids are ULID strings from `newId()`. Times are UTC `timestamptz`.
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
- `test/setup/mock-marketplace.ts`: fake Shopee and TikTok Shop that enforce the documented signatures and token rules

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
- Never hold a database transaction open across an HTTP call to a marketplace: the worker role ends sessions idle in a transaction after 10 seconds. Call marketplaces only through `MarketplaceGateway` (rate limit, sync log, token refresh); for a lock that must span the call use `withAdvisoryLock`.
- Webhook signatures cover the exact raw body. The webhook process parses no JSON before verifying (`webhook/webhook-app.ts`); do not add a JSON body parser there.
- `outbox.enqueue` writes nothing for an event that no job consumes yet, so a test cannot look for that event's row.
- Tests that touch BullMQ use the run's prefix (`infra.keyPrefix`, passed by `startApi`, `startWorker`, `startWebhook`); jobs under the default `bull` prefix would reach any worker sharing the Redis.
- In the Indonesian market the TikTok Shop channel is shown as "Tokopedia & Shop" (platform branding rule, PRD 5.6); the internal channel id stays `tiktokshop`.

## Definition of done
Tests per section 13.3 (integration tests run as the application roles, never as a superuser), migration checklist 12.3, docs updated (module README and the backend doc section you touched), PR checklist 15.11.
