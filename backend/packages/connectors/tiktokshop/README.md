# TikTok Shop connector: coverage audit

The connector serves Indonesian sellers under the **Tokopedia & Shop** display name. It implements
selected seller workflows, not every TikTok Shop API or Partner Center capability. Seller, creator
and affiliate-partner authorizations are different principals; `exchangeCode` currently accepts only
seller tokens; the optional `accounts` adapter separately supports creator/affiliate-partner grants. An app key alone does not grant every API scope or market.

## Application flows

Existing consumers cover shop authorization and token refresh, warehouse mapping, catalog pulls,
listing activation, inventory updates, listing copies, order imports/cancellations, shipping slots,
labels, tracking, returns and selected webhooks. Calls from the worker go through
`MarketplaceGateway.call`; the API process never calls a marketplace directly.

The repository-root `AUDIT-INTEGRASI-TIKTOKSHOP.md` describes the gaps and source evidence. Generated
files enumerate the official navigation tree, API versions, code references and app-review rules.
Counts of endpoint references do not measure complete seller features or successful sandbox testing.
Internal sales reports do not implement TikTok Analytics, and Xendit subscription payments do not
implement TikTok Finance or settlement reconciliation.

## Reproduce the inventory

From `backend/`:

```sh
pnpm audit:tiktokshop --snapshot /path/to/tiktok-documentation-snapshot
```

`--output-dir` optionally changes the generated file destination. The command reads data and local
TypeScript AST only; it makes no network requests and executes no downloaded code. No dependency or
lockfile change is required.

The public documentation application at `https://partner.tiktokshop.com/docv2/` uses these read-only
resources on the same host:

- `GET /api/v1/document/tree?workspace_id=3`: save the complete response as `tree.json`.
- `POST /api/v1/document/details` with `workspace_id: "3"` and a `document_id` array: save each
  `data.document_detail_list` entry as `details/<document_id>.json`. This is a documentation read,
  not an app or seller mutation. Include every leaf and all API versions returned below.
- `GET /api/v1/document/api_external/list?api_config_version=2&document_id=<id>` for every API Reference
  leaf of `doc_type=1`: save `data` as `versions/<id>.json`. Fetch the referenced version documents too.
- `GET /api/v1/document/api_meta?src_document_id=<id>`: save `data` as `api-meta/<id>.json` for each
  API version. Only scope names/keys are exported, not unrelated metadata fields.

Save `snapshot.json` with `fetched_at` (ISO UTC), `tree_sha256` (SHA-256 of the exact `tree.json` bytes)
and `issues` (unresolved fetch failures). Do not use cookies, account credentials or private seller
data for this public audit. Respect rate limits and record failures instead of silently omitting
documents. The tool refuses incomplete navigation/version documents and verifies explicit method/path
against API metadata when available. Missing scope metadata stays unverified.

Endpoint matching distinguishes HTTP methods and versions. It expands literal conditional branches
and normalizes dynamic ID placeholders; comments/tests are excluded. Nonliteral computed endpoints
still require code review. A version on the official dropdown is not automatically retired, and a
new default version is not automatically a required migration without reviewing the changelog.

## Verification limits

The existing package tests use fake HTTP transports. They cover signing, authorization, webhooks,
catalog, stock, orders, fulfillment, product publishing and returns. They are not proof of a live
Partner Center approval, granted production scopes, sandbox success, real label output or every
market-specific scenario. The audit does not expose placeholder screens or add unused connector APIs.

Before releasing additional functionality, check the operation's current official contract and
principal/market/scope, implement the tenant service/worker/outbox/API/UI flow and appropriate tests,
then validate against authorized sandbox accounts. App Store initiated authorization needs its own
secure flow; removing the existing tenant-bound `state` check is not a fix.

## Regular price updates
`catalog.updatePrices` now has an application consumer: persistent per-listing requests, the outbox/worker, read-before-write and confirmation, tenant/store permissions, cancellation of unsent work, audit/export and a rupiah modal. It does not edit promotion prices or implement automatic channel pricing. Authentication/transient errors propagate, business refusals are explicit and local transport tests cover the contract; real sandbox validation remains pending.

## Creator/partner connections

`accounts` implements the current ROW authorization URLs and token exchange/refresh for creator
(user_type 1) and partner (3). It validates identity/scopes, reads Creator Profile 202508 or Authorized
Category Assets 202405, and accepts Indonesian selection regions/assets only. No seller shop_cipher
is sent. Private category ciphers are separated from public metadata and redacted in call summaries.
The application consumer is `src/modules/affiliate-accounts` and UI `/affiliate/akun` (ADR-047).
Signed mock tests cover transport; real Creator API/TAP approval/test-account access remains missing.
The connection foundation owns authorization; business operations such as collaboration, samples,
links, content and performance are exposed through the reviewed commerce registry and workspace.

## Reviewed commerce contracts

`tools/generate-tiktok-commerce-contracts.py` compiles the pinned public documentation into the
317 default descriptors, 390 runtime scope contracts, documented batch-failure containers and
endpoint-specific query array encodings. Use `--snapshot /path/to/snapshot`; it makes no network
requests, verifies completeness and checksums, and never infers a missing API scope. Format the
generated files with the command printed by the compiler. Exact-source reviewed exceptions are
included in `TIKTOK_COMMERCE_CONTRACT_CAPTURE.reviewedContracts`; changing their source bytes
requires an explicit re-review. Regression tests run with
`python3 -m unittest tools/test_generate_tiktok_commerce_contracts.py` from `backend/`.

Tokopedia product mapping keeps the documented GET JSON body. The narrow Node HTTP transport
accepts only that exact configured API origin/path, sends the same signed bytes, never follows
redirects, and preserves shared timeout/rate/response limits and safe observation. Decimal int64
IDs remain strings at the application boundary and numeric JSON on the wire, without Number
rounding. Other GET-body contracts remain disabled. Affiliate conversation listing uses its
explicit query field instead of the redundant optional GET-body copy.

String query arrays use the CSV encoding shown in each official API example; numeric video ID
arrays use exact numeric JSON only where the example specifies that encoding. The compiler refuses
unproven encodings. Customer Service message types retain every documented enum value. Messages
without explicit `is_visible: true`, including hidden conversation previews, are removed before
generic result caching and public projection.

Return shipping information supports signed multipart with two independently bound optional PDF
files. Official error 25021023 limits documents to PDF. Application limits are 10 MB for a label
and 2 MB for a QR document; these limits do not claim provider maximums. File IDs, permissions,
tenant/account ownership and expiration are enforced by the commerce module.

Large uploads supply rate feedback for every raw chunk without exposing the returned URL or
upload credentials; feedback is bounded to one second and cannot change an acknowledged outcome.
Customer Service video uses the same fixed target for small uploads too: Upload File Init
explicitly permits a single chunk at 5 MiB or less, and no direct small-video endpoint is published.
Creator assets up to 500 MiB can be prepared, but the official Post Shoppable
Video reference names the direct upload's `file_id`; it does not establish equivalence with the
large upload's `resource_id`. Automatic substitution remains unavailable. Four newest API
documents also lack published scope metadata. The exact findings, hashes and official links are
recorded in `docs/audits/tiktok-remaining-contract-review.json`.

## Runtime granted-scope enforcement

Existing seller features and the operation catalogue share the same signed transport. The worker
enters `withGrantedScopes` with persisted grant metadata; `TiktokShopClient.call` and multipart
`upload` check the exact HTTP method, API version and dynamic path before sending each request.
`runtime-scope-contracts.ts` contains the 390 published endpoint versions captured on 17 October 2026,
including older versions still used by existing flows. Unknown method/version or an absent documented
scope contract fails closed. Token exchange/refresh and dedicated initial profile discovery remain
separate authorization operations; their strict grant/identity checks still apply.

Official scope `auth_type` selects seller (1), creator (2) or partner (4) packages, so a creator does
not require an unrelated seller package on a shared API. At least one applicable documented package
is a necessary local precheck. This does not establish package AND/OR semantics or prove sufficient
permission, program eligibility or app approval; the marketplace remains the final authorization
boundary and permission refusals remain permanent failures. Ordinary seller order/fulfillment scopes
work independently of the full-service seller package listed in the metadata. Read scopes do not
imply writes or adjacent feature scopes that the API does not explicitly list.

`MarketplaceGateway` reloads both token and scope metadata after refresh before its one retry. Its
context is limited to the operation and isolates concurrent accounts. A denied operation makes no
HTTP request and does not mark an otherwise connected shop as revoked. Production code must use the
gateway; isolated connector transport fixtures have no ambient application grant. Targeted tests:
`scope-guard.spec.ts`, core `scope-context.spec.ts`, and backend `marketplace-scopes.spec.ts`.
