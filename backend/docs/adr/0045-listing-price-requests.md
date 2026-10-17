# ADR-045 — Confirmed marketplace price changes

Date: 2026-10-17. Status: accepted for implementation; live marketplace validation pending.

Regular SKU price changes are persistent requests, separate from the last marketplace snapshot.
They use the outbox/worker, tenant/store scopes, an idempotency key, requester permission checks,
the dedicated `price:write` permission, one pending request per listing, a worker lease and read-after-write confirmation. Retry after an
accepted write only checks confirmation, so it does not overwrite a later Seller Center change.
Accepted writes cannot be cancelled as if they were still unsent. A custom BullMQ backoff honours
marketplace retry hints and the current lease deadline, allowing a restarted process to reclaim work
instead of completing a busy job without processing it. Disabled users and closing tenants are refused.

The request's listing and store must belong together. Its foreign key is therefore exactly
`(tenant_id, listing_id, store_id)` to `channel_listing(tenant_id, id, store_id)`, a stronger form of
the normal two-column tenant foreign key. The schema check explicitly verifies these three columns
for this constraint; all other tenant foreign keys retain the two-column check. Tenant isolation,
RLS, audit and export requirements remain mandatory. No applied migration is modified.

Indonesian local prices use whole IDR. TikTok cross-border price changes use the final display price
field, distinct from pre-tax price. Promotion locks remain permanent refusals. Official TikTok
documentation and the pinned secondary Shopee contract underpin local transport tests; real scopes,
app approval and sandbox verification remain separate release requirements.
