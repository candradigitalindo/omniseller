import type { CommerceOperation } from "@omniseller/connector-core";
import { AFFILIATE_CREATOR_OPERATIONS } from "./commerce-contracts/affiliate-creator.js";
import { AFFILIATE_PARTNER_OPERATIONS } from "./commerce-contracts/affiliate-partner.js";
import { AFFILIATE_SELLER_OPERATIONS } from "./commerce-contracts/affiliate-seller.js";
import { ANALYTICS_OPERATIONS } from "./commerce-contracts/analytics.js";
import { AUTHORIZATION_OPERATIONS } from "./commerce-contracts/authorization.js";
import { CUSTOMER_ENGAGEMENT_OPERATIONS } from "./commerce-contracts/customer-engagement.js";
import { CUSTOMER_SERVICE_OPERATIONS } from "./commerce-contracts/customer-service.js";
import { EVENT_OPERATIONS } from "./commerce-contracts/event.js";
import { FINANCE_OPERATIONS } from "./commerce-contracts/finance.js";
import { FULFILLED_BY_TIKTOK_FBT_OPERATIONS } from "./commerce-contracts/fulfilled-by-tiktok-fbt.js";
import { FULFILLMENT_OPERATIONS } from "./commerce-contracts/fulfillment.js";
import { LOGISTICS_OPERATIONS } from "./commerce-contracts/logistics.js";
import { ORDERS_OPERATIONS } from "./commerce-contracts/orders.js";
import { PRODUCTS_OPERATIONS } from "./commerce-contracts/products.js";
import { PROMOTION_OPERATIONS } from "./commerce-contracts/promotion.js";
import { RETURN_AND_REFUND_OPERATIONS } from "./commerce-contracts/return-and-refund.js";
import { SELLER_OPERATIONS } from "./commerce-contracts/seller.js";
import { SUPPLY_CHAIN_OPERATIONS } from "./commerce-contracts/supply-chain.js";
import { TOOLS_OPERATIONS } from "./commerce-contracts/tools.js";

/** Public documentation provenance; these counts are contract coverage, not live marketplace approval. */
export const TIKTOK_COMMERCE_CONTRACT_CAPTURE = {
  fetchedAt: "2026-10-17T04:13:18.315145+00:00",
  treeSha256: "b1005604b13fc9052c89812176caaa07da58b69b4c1a0c8223cc7c363a7b6ec7",
  apiMetadataSha256: "3e3699f2bd09f8380cbf2cfa8b967a8f408af73c399ea63546dec41acd6d4341",
  documentDetailsSha256: "614e00031d5df0eb1a1c4fc074280934b89bb12ee91ee6134e8104649d1223b0",
  versionListsSha256: "ac0b446c58bf95e78382d164f2abf642e033c63f4aa01dfa0f699b9731c4a6a8",
  navigationEntries: 973,
  catalogOperations: 317,
  apiVersionDocuments: 390,
  availableContracts: 257,
  scopeSemantics:
    "An applicable listed package is a necessary condition only; marketplace authorization remains authoritative. FBT requires its additional documented onboarding preflight scope.",
  eligibility: "App approval, Indonesia market/program and actual account grants remain runtime prerequisites.",
  dedicatedMutationPolicySource:
    "AUDIT-TIKTOKSHOP-KODE.csv at repository commit 834f22d869ae0378bdc29e7c9a4aa7b6573944a1",
} as const;

/** Reviewed static method/path allowlist. Authorization and existing owned mutations use dedicated workflows. */
export const TIKTOK_COMMERCE_OPERATIONS: readonly CommerceOperation[] = [
  ...AFFILIATE_CREATOR_OPERATIONS,
  ...AFFILIATE_PARTNER_OPERATIONS,
  ...AFFILIATE_SELLER_OPERATIONS,
  ...ANALYTICS_OPERATIONS,
  ...AUTHORIZATION_OPERATIONS,
  ...CUSTOMER_ENGAGEMENT_OPERATIONS,
  ...CUSTOMER_SERVICE_OPERATIONS,
  ...EVENT_OPERATIONS,
  ...FINANCE_OPERATIONS,
  ...FULFILLED_BY_TIKTOK_FBT_OPERATIONS,
  ...FULFILLMENT_OPERATIONS,
  ...LOGISTICS_OPERATIONS,
  ...ORDERS_OPERATIONS,
  ...PRODUCTS_OPERATIONS,
  ...PROMOTION_OPERATIONS,
  ...RETURN_AND_REFUND_OPERATIONS,
  ...SELLER_OPERATIONS,
  ...SUPPLY_CHAIN_OPERATIONS,
  ...TOOLS_OPERATIONS,
];
