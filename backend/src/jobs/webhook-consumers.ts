import { AFFILIATE_ACCOUNT_WEBHOOK_CONSUMERS } from "../modules/affiliate-accounts/accounts.jobs";
import { CATALOG_WEBHOOK_CONSUMERS } from "../modules/catalog/catalog.jobs";
import { CHANNEL_WEBHOOK_CONSUMERS } from "../modules/channel/channel.jobs";
import { FULFILLMENT_WEBHOOK_CONSUMERS } from "../modules/fulfillment/fulfillment.jobs";
import { ORDER_WEBHOOK_CONSUMERS } from "../modules/orders/orders.jobs";
import { RETURN_WEBHOOK_CONSUMERS } from "../modules/returns/returns.jobs";
import { mergeConsumers } from "../modules/sync/webhook-consumer";

/** What happens to each kind of marketplace notification; modules append their consumers here. */
export const WEBHOOK_CONSUMERS = mergeConsumers(
  CHANNEL_WEBHOOK_CONSUMERS,
  AFFILIATE_ACCOUNT_WEBHOOK_CONSUMERS,
  CATALOG_WEBHOOK_CONSUMERS,
  ORDER_WEBHOOK_CONSUMERS,
  FULFILLMENT_WEBHOOK_CONSUMERS,
  RETURN_WEBHOOK_CONSUMERS,
);
