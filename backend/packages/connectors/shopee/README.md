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
