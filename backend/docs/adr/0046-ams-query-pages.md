# ADR-046 — Asynchronous AMS product query pages

Date: 2026-10-17. Status: accepted for development; current contract and live sandbox validation pending.

AMS open campaign products are fetched one requested page at a time through the outbox and worker.
An API request creates `affiliate_product_query`; polling reads its normalized result without exposing
marketplace credentials or opening a transaction during HTTP. Queries retain their filters, sorting
and opaque cursor so subsequent pages use the same parameters. This is an on-demand snapshot, not a
complete campaign synchronization or campaign editing module.

Tenant RLS, composite store/user foreign keys, the store scope, `affiliate:read`, requester permission
rechecks, an idempotency key, a five-minute claim lease and explicit status transitions apply. Only
seller Shopee Indonesia is accepted. Read-only stores can be read. Creator and affiliate partner
principals for TikTok require independent authorization and are not inferred from seller credentials.

Results expire after 24 hours. Queries over seven days past expiry are removed on subsequent reads
requested for that store; disconnected stores requesting data deletion also remove the pages. Results
are included in the full tenant export, and query creation/status changes are audited. Commission
basis points and int64 product IDs remain exact; explicit unlimited periods remain null.

The existing adapter's pinned secondary contract is used because the official Shopee portal still
returns an access denial in this environment. This feature's local tests are not proof of entitlement,
acceptance of AMS terms, approval or current official API behavior. Other AMS endpoints remain open.
