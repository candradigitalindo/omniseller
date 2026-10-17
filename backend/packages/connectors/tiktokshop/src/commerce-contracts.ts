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
  availableContracts: 260,
  reviewedContracts: {
    "650a9191c16ffe02b8eec161": {
      metadata: "ae6284ae84bfa69c827502287a7e458db32c342b1bd3d2d25666a3b265ad5cb0",
      document: "08583916029fe9cce0ba77e318313fea3d8b3880d7c97bbcc62e827949c144f0",
      readOnly: true,
      decision:
        "Inventory Search explicitly retrieves inventory for product_ids/sku_ids. Its POST request contains only search identifiers, never quantities or updates.",
    },
    "69dde24cf76068049e2730b8": {
      metadata: "51bda8d035e65db796a44a1659c8d4a674da9cc29f20459e86352c75bc277503",
      document: "d93158ebf86cb52295bae0bdba58c29bb8c31ce7afd7be96d6695eed9ca87341",
      readOnly: true,
      decision:
        "List Opportunities explicitly searches and retrieves paginated leads using category, timestamp, type and tag filters; it does not create or change opportunities.",
    },
    "6a296867f76068049e634aa4": {
      metadata: "977c1789335973cb0e9a968aeb0ce502e693d087534c13225175598cc2bb210b",
      document: "3b83ddca540674ada38299685dc1c498de7fc401775b483b4896c368408848f6",
      readOnly: true,
      decision:
        "List Product SKPP Statuses is explicitly a batch status query using product IDs, a status filter and pagination; no update is submitted.",
    },
    "67287d619ba2a002fe590322": {
      metadata: "143953e859358624317242bf4f4ca8ab16dda1194f098f964dbd42871ca3dd9a",
      document: "c29c25fc822de836b03868df3781deef218e78464233ea8badb025440fdd9038",
      readOnly: true,
      decision:
        "Creator Search Sample Application Fulfillments explicitly queries existing fulfillment statuses; its body is a status filter rather than a fulfillment command.",
    },
    "66716aa19a01ec02e5b90513": {
      metadata: "6d7210413d296aec09946412969d225916f84b7f550a9fff95d34f81422dea20",
      document: "b934febe716093fa98eb31e0435335758c981c44965c1af6ef345067992306aa",
      readOnly: true,
      decision:
        "Seller Search Open Collaboration Products explicitly searches eligible products using keyword/category/price/commission filters; no collaboration or product is changed.",
    },
    "6a335dc2f180ee049bf09ed6": {
      metadata: "1adb2ad3cd8de4c71385e7a3b9ad014b826829f1bdcaa439d83a604f088e5185",
      document: "7aa4cc29897d14dab977750213e8435061c9327e5deb67244fc2e37ca4695c4c",
      decision:
        "The GET JSON body is explicit in the request table and Go/Java/Node SDK examples; the dedicated transport preserves it. Tokopedia int64 identifiers use exact decimal-string input and numeric JSON wire values.",
    },
    "6791db764ddec3030b395150": {
      metadata: "bc8e0f12777bc63e796d0d4b0ca1af01749571aaf36a08ea78a0e87c2c3ff5af",
      document: "0e841ce2574376a0e8813f766010f316c3ede0e841c2bc0e988eeba1806eed1c",
      decision:
        "only_need_conversation_id is explicitly documented and sampled as a query field; omit its redundant optional GET body copy.",
    },
    "68c8c9ed5514fb049cae029f": {
      metadata: "64738a50a601142147c77e89f316a109690daf4124597f9860cccde9e215fed8",
      document: "53acfe2edb7fdd85530f148fef74f1df336720af82e6402b1a3642c6ced28063",
      decision:
        "The official Path and query example explicitly name campaign_id and product_id placeholders. Require opaque strings without coercion; never substitute a different endpoint or infer a missing permission.",
    },
  },
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
