# ADR-047 — Separate creator and affiliate-partner principals

Date: 2026-10-17. Status: accepted for local development; real Creator API/TAP access pending.

The requested Indonesian creator and affiliate-partner scope cannot use seller store credentials.
`MarketplaceConnector.accounts` authorizes these principals separately. Creator links use app_key;
ROW partner links use service_id. The registered TikTok callback is shared, with a distinct `a1_`
state namespace. State is random, hashed, tenant/requester-bound, expires after 30 minutes and is
consumed once. App Store initiated installation remains a separate backlog item.

Only the worker exchanges codes or refreshes tokens. It verifies user_type (1 creator, 3 partner),
open_id, granted_scopes and an Indonesian creator selection region or authorized category asset.
Refresh must retain the same principal and minimum scopes. Creator Profile 202508 and Authorized
Category Assets 202405 are current official contracts. Category ids are returned facts, never
inferred from names; an Indonesian asset alone does not prove TAP feature entitlement.

Migration 0033 adds account metadata, worker-only encrypted credentials and authorization history.
Token AAD includes the account/authorization id and token field. A successful code exchange is sealed
as a staged grant before profile probing, so a transient failure/restart resumes verification without
exchanging the consumed code. Refresh persists its replacement before probing as well. Lease claims,
principal locks and a global partial unique index prevent duplicate work and active cross-tenant
ownership. Reauthorization to a selected account must retain its identity. Tenant key locks precede
credential writes; refreshed tokens are compared under those locks, so DEK rotation does not discard
a valid single-use refresh replacement. Disconnect or business closure cannot revive credentials.

`affiliate:account_read` and `affiliate:account_write` govern tenant-level account metadata and
management independently of seller store scopes; built-in Owner/Admin roles in all tenants receive
both. Permission is rechecked before exchange and after profile verification. RLS/composite FKs,
audit, two public metadata export sheets, API/OpenAPI and the `/affiliate/akun` modal UI apply.
Credentials, staged grants, state and codes are excluded from public output/export/audit. Ciphers
are masked in HTTP summaries and logs; SQL parameter arrays are not logged.

Disconnect removes local credentials and soft-cancels pending connections, retaining authorization
history. Worker cleanup clears terminal staged grants, and a 15-minute scan retries cleanup and
expires abandoned authorizations after their lease. The same scan schedules due/verifying account
refresh once per time slot, only for active businesses. History follows the existing tenant purge
policy; this change introduces no permanent authorization-history deletion route.

Official authorization overview, creator and partner guides, and both API documents were read on
17 October 2026. The user confirmed no Creator API/beta or Affiliate Partner/TAP access and requested
local development. Signed mock tests cover the complete local connection flow, permissions, tenant
isolation, restart, token rotation and closure. They do not establish real platform approval or
sandbox readiness. Collaboration, samples, affiliate links, commissions and performance workflows
remain separate implementation work.
