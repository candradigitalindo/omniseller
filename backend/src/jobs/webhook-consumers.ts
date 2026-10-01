import { CHANNEL_WEBHOOK_CONSUMERS } from "../modules/channel/channel.jobs";
import { mergeConsumers } from "../modules/sync/webhook-consumer";

/** What happens to each kind of marketplace notification; modules append their consumers here. */
export const WEBHOOK_CONSUMERS = mergeConsumers(CHANNEL_WEBHOOK_CONSUMERS);
