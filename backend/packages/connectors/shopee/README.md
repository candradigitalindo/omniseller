# Shopee connector: coverage and AMS

This package implements parts of Shopee Open Platform v2 for Indonesia. A working connector does not
mean every Shopee API, region, app type or seller programme is supported.

## Coverage inventory

Repository-root files:

- `AUDIT-SHOPEE-ENDPOINTS.csv`: every endpoint in the audited snapshot, source URL, app permissions,
  source evidence, owning domain and UI references where present.
- `AUDIT-SHOPEE-GUIDES.csv`: the 48 developer guides in that snapshot, their dates and headings.
- `AUDIT-SHOPEE-RINGKASAN.md`: generated module totals.
- `AUDIT-INTEGRASI-SHOPEE.md`: interpretation, release gates and implementation gaps.

The official portal returned HTTP 403 from this cloud environment. The inventory therefore uses the
public documentation snapshot from `nhutplus/marketplace-api-docs`, pinned to
`300344af94cf347268b50847baf14b9c28aaf1ae`, crawled on 2026-05-15. These are secondary sources, not a
claim that the current official catalogue has exactly 428 endpoints. Chat and restricted APIs may be
absent from that snapshot. An endpoint reference is not evidence of a complete application feature.

Reproduce the inventory from the downloaded documentation tree, from `backend/`:

```sh
pnpm audit:shopee \
  --snapshot /path/to/snapshot/shopee \
  --snapshot-source https://github.com/nhutplus/marketplace-api-docs/tree/300344af94cf347268b50847baf14b9c28aaf1ae/shopee
```

The input directory must contain `api-reference/*.metadata.json`, corresponding `*.structured.json`,
and `developer-guide/` equivalents. Obtain those data files at the pinned revision; do not run scripts
from the snapshot repository. `--output-dir` changes the output directory. The tool reads TypeScript
AST string literals in production connector files, excludes tests/comments, and records unmatched
paths separately. It does not infer missing HTTP methods from endpoint names or JSON payloads.

## Read-only AMS operation

`createShopeeConnector(config).affiliate.listOpenCampaignProducts(shop, query)` implements the transport
and normalization for `v2.ams.get_open_campaign_added_product`:

- signed **GET** `/api/v2/ams/get_open_campaign_added_product`;
- page size 1–100, opaque cursor, commission sorting and search by item name or up to 50 item IDs;
- IDs remain strings, including int64 values beyond JavaScript's safe integer range;
- rates are integer basis points: 1.11% becomes 111; the unlimited end timestamp becomes `null`;
- commission protection periods, pending termination and maximum commission for the current day are
  retained; unknown future statuses remain `unknown` with their original value;
- malformed responses and a repeated/missing continuation cursor fail explicitly;
- missing AMS entitlement, app permission or seller terms acceptance remains a permanent business
  failure; it is not treated as an expired token or a reason to unlink a store.

Contract sources: official API URL
`https://open.shopee.com/documents/v2/v2.ams.get_open_campaign_added_product?module=127&type=1`,
guide `https://open.shopee.com/developer-guide/702`, their pinned secondary snapshot, and the independently
published parameter schema in `congminh1254/shopee-sdk` at `fce5d8fa87aaae7ad9cabd6cdaf73aef61112cb5`.
The snapshot explicitly lists **Affiliate Marketing Solution Management** as an allowed app type.
Current permissions must be confirmed in the developer Console; credentials alone do not establish
eligibility, country availability or seller AMS activation.

`MarketplaceConnector.affiliate` is optional. The TikTok Shop connector does not advertise it.
The affiliate application module now consumes it through an outbox job, MarketplaceGateway,
tenant/store scopes, `affiliate:read`, persistent one-page results and the `/affiliate` UI. It remains
read-only; current official contract, app/shop eligibility and real sandbox validation are pending.
Other AMS operations remain unimplemented (ADR-046).

## Validation and release gates

The Shopee package has contract-style tests using synthetic payloads and a fake transport. They cover
the named API's signed request, search/pagination, precision, errors and malformed responses, alongside
the existing product, stock, orders, logistics and return tests. They are not live sandbox tests.

Before making AMS available to users: confirm the latest official contract and eligible app/shop,
obtain sandbox credentials, and run
real sandbox verification. Creating/editing affiliate campaigns additionally needs explicit handling
of commission protection, asynchronous batch results and seller terms; no write operation is added here.

## Regular price updates
`catalog.updatePrices` now has an application consumer: persistent per-listing requests, the outbox/worker, read-before-write and confirmation, tenant/store permissions, cancellation of unsent work, audit/export and a rupiah modal. It does not edit promotion prices or implement automatic channel pricing. Authentication/transient errors propagate, business refusals are explicit and local transport tests cover the contract; real sandbox validation remains pending.

## Exact identifiers and stock confirmation

Shopee int64 identifiers remain decimal strings in the application. `identifiers.ts` validates the
non-negative signed-int64 range and emits exact **JSON numbers** with Node 24 `JSON.rawJSON` when a
value exceeds JavaScript's safe integer range. An unsafe number already rounded by a caller is
rejected. Token exchange/refresh, stock, item status, order cancellation, product/category/attribute/
brand/variation and logistics writes share this helper; identifiers received through `parseJsonSafe`
are compared as exact decimal strings. Pickup address and logistics channel IDs are also sent as
numbers, rather than quoted large strings. No credentials or request payloads are logged by tests.

`update_stock` succeeds for a model only when its `success_list` explicitly acknowledges **every
requested location and its exact absolute stock quantity**, including zero. The documented stock
field is returned for requests using `seller_stock`; a missing model ID is never inferred as model 0.
An empty/malformed response, missing location, repeated acknowledgement or changed quantity leaves
the model unconfirmed and retryable. Explicit business refusals retain their classification, and a
failure takes precedence over a contradictory success. Other models may still succeed independently.
Unlist and price acknowledgements likewise require the exact item/model and requested result.

Contract: `v2.product.update_stock`, pinned snapshot
`300344af94cf347268b50847baf14b9c28aaf1ae`, request/response parameter tables (2026-05-15),
`https://open.shopee.com/documents/v2/v2.product.update_stock?module=89&type=1`.
Synthetic transport tests include `9007199254740992` beside `9007199254740993`, signed-int64 bounds,
per-location partial acknowledgements and malformed success/failure lists. Current official contract
and real sandbox verification remain release gates.

## Reviewed commerce operations

`commerce.operations` contains a static catalogue of all 428 endpoints in the pinned snapshot across
28 modules. The explicit method in each Markdown document supplies HTTP-method evidence, including
the 143 methods the older code-example-only audit could not extract. Each descriptor retains the
source filenames, SHA-256 hashes and pinned commit. This is a snapshot catalogue, not a claim that
428 features have been completed or that all app programs are approved.

Executable local contracts cover additional seller AMS
campaigns/performance, discounts, vouchers, flash sales, bundles, add-on deals, ads, store categories,
account health, payment reports, and verified new product/order/return/logistics commands. Nested
inputs require a complete documented JSON payload; duplicate, missing or contradictory nesting stays
unavailable. Existing stock, regular prices, cancellation, fulfillment and return workflows retain
their owning modules. New accepted product/order/return commands trigger owning-module reconciliation
through the application consumer; `accepted` means Shopee acknowledged the request, not that all
processing has finished or local facts were confirmed.

Unavailable descriptors include existing owned operations, merchant/global-account scope,
app-level credentials and configuration, file workflows, unresolved schemas and pagination, and
unresolved app-level workflows. Private PDF downloads for booking documents and shipping-document jobs
return bytes to the worker for private, short-lived artifacts. They accept only PDF content up to 20 MB;
redirects are capped at three and must remain on the configured Shopee API origin. JSON file links
are never followed. Invoice upload/download restricted to PH/BR, Taiwan-only TO labels and Brazil-only
KML uploads remain unavailable for Indonesia. FBS tax invoice workflows remain unavailable: the
snapshot does not establish Indonesian program eligibility, uses conflicting status names and
numeric error envelopes, and does not establish an allowlist for private file-link hosts.

Video/Live APIs use **user_id** authentication and independently refreshed user credentials. Guides
[669](https://open.shopee.com/developer-guide/669) and
[706](https://open.shopee.com/developer-guide/706) establish `auth_type=user`, the code exchange,
`user_id_list`, user-specific refresh, and user HMAC signing. The connector rejects ambiguous
multi-user grants and changed identities. The configured callback and CSRF state are application
owned. Shopee exposes no account-country lookup in this snapshot: the selected market is Indonesia,
with `regionVerified=false`; it must not be displayed as a verified country. Live requires a
Livestream Management app; Video requires a Shopee Video Management app and accepted Video terms.
A seller shop token never substitutes for a user grant.

Product video upload is a composite operation: a private MP4 up to 30 MiB initializes MediaSpace
with a file MD5, uploads exact 4 MiB parts (except the last) with per-part MD5 and public signatures,
then completes once. The separately documented result read confirms asynchronous transcoding.
Shopee Video uses the distinct public Media API: the server-returned `part_size` controls bounded
range reads, `part_md5` names the chunk digest, and the initial request fixes business 3/scene 1.
The local upload ceiling is 500 MiB (the official Media API allows 1 GiB), with duration 1–180 seconds.
Accepted upload never means published video; editing and publishing are separate reviewed requests.
Malformed initialization, chunk or completion acknowledgements stop the workflow without automatic
resends. Private image uploads cover product images, Live covers, and return evidence (business 2,
scene 1). Returned stream keys, signed playback/push URLs and file links are excluded from generic
JSON history; they must never reach sync logs or exports.

Shopee app programs come from the documented **API Permissions** section. They are displayed as
unverified eligibility metadata, never invented OAuth scopes: possession of a key/token does not
prove Console approval, seller activation or Indonesia availability. Documented cross-border/local
account requirements are separate from app programs and are checked against the fresh connected-shop
profile; a missing `is_cb` value remains unknown rather than being treated as a local seller. Marketplace business refusals
remain explicit, and API secrets/common authentication parameters cannot be supplied as form fields.
Only static paths are callable. HTTP observers record operation metadata only, and arbitrary external
error text is replaced before it can reach sync logs. Public response fields follow the source schema
and exclude personal data, credentials and private download URLs.

Pagination uses the exact source response paths: AMS `cursor` with `has_more`, payment payout
`next_cursor` with `more`, and income-detail `income_detail_list.next_page.cursor` at the response root. Missing,
malformed or repeated continuations fail explicitly. Only documented initial empty cursors permit
required empty text. Writes require an explicit successful envelope/request ID; partial failures
never report an accepted overall result and require the seller to inspect marketplace results before
trying again.

Regenerate from the pinned data files, then apply the repository formatter:

```sh
python3 tools/generate-shopee-commerce.py --snapshot /path/to/snapshot/shopee/api-reference
pnpm format
```

Method provenance is also saved at `backend/docs/audits/shopee-commerce-method-evidence.json`.
These are local contract tests and implementations. Current official-document review, program
entitlement and real sandbox validation are still required before release.
