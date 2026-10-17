# Creator and affiliate partner accounts

Owns Indonesia creator/affiliate-partner connections independently of seller stores. Seller tokens
are never reused for a creator or partner call. The user explicitly included these principals in scope.

Implementation contract: a single-use, tenant-bound state returns through the existing registered
TikTok callback. Only the worker exchanges codes, verifies user_type/open_id/granted_scopes, reads
creator selection_region or authorized partner category assets, and seals credentials. Creator uses
app_key in its authorization URL; partner uses service_id. Token bytes and category asset ciphers
never reach API responses, exports or audit logs. Business calls use MarketplaceGateway pacing/logging.

Creator account testing may require the platform beta/allowlist and an App Store Manager test account.
Partner development accepts authorization only from the app owner, and the current supported category
is Seller and Scalable Creator Match-Up (TAP). Partner category ids/ciphers are marketplace facts;
never infer an id from a mutable category name. Actual app scopes and real sandbox remain unverified.

Source contracts read on 17 October 2026: Authorization overview, Creator authorization guide,
Partner authorization guide, Get Creator Profile 202508, Get Authorized Category Assets 202405.
Pending work is tracked in IMPLEMENTASI-MARKETPLACE.md; this README is not a release claim.

## Application flow

`accounts.service/repository` own metadata and authorization state. HTTP controllers expose list/get,
rename (If-Match), disconnect, refresh (202 plus Idempotency-Key), start and callback/status. Permissions
are `affiliate:account_read`/`affiliate:account_write`, granted dynamically to Owner/Admin in existing
and new tenants. These are business-level account permissions, independent of seller store scopes.
UI `/affiliate/akun` lives in Pemasaran, with searchable choices, paginated cards and modal profile,
scopes/category metadata, rename, refresh and confirmed disconnect. Callback state `a1_` selects this
flow at `/integrasi/callback/tiktokshop`; seller callback states retain their existing flow.

`authorization_received` -> `affiliate_account.authorize`; `refresh_requested` ->
`affiliate_account.refresh`; `grant_cleanup_requested` -> `affiliate_account.grant_cleanup`.
Jobs use mp.outbound, MarketplaceGateway pacing and redacted sync records with no seller store id.
`accounts-connect.service` claims a five-minute lease, stages an encrypted grant before profile HTTP,
rechecks the requester's current permission, then atomically connects metadata and credentials.
A retry resumes a staged grant. `accounts-credentials.service` serializes refresh per account,
persists rotated tokens before probing, verifies identity/scopes, and respects concurrent disconnect.
Key rotation includes both account credentials and staged grants through `account-token-rotation`.

Migration 0033 is applied locally. API grants permit only safe authorization metadata and explicitly
named INSERT columns; private grant fields and credential/cipher reads remain worker-only. Account
and authorization statuses have DB transitions and audit triggers. Full business exports contain two
metadata sheets without state, codes, tokens or private assets. Audit presentation names account and
connection status changes. Logging masks cipher keys and SQL bindings containing serialized secrets.

Disconnect and business closure remove local credentials, soft-cancel pending work and enqueue staged
grant cleanup while retaining history. The 15-minute scheduler selects only routing metadata: due or
verifying accounts in active businesses, terminal grants needing cleanup, and expired authorizations
without a live lease. It queues worker jobs, never changes tenant data itself. Marketplace consent
must also be revoked at the platform when required. History follows the existing business purge policy.

Tests: TikTok account connector contract tests and `test/e2e/affiliate-accounts.e2e.int.spec.ts`, schema,
DB role privileges, generated tenant isolation, closure, UI/callback and responsive browser tests.
Real access remains unavailable; campaign/collaboration/sample/link/performance operations are backlog.
