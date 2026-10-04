import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/**
 * Send this in-app notification by email too (backend doc 8.17, 8.23): written with the notification,
 * for kinds that always go out by email (a store's connection lost, L44 "Selalu dikirim").
 */
export const notificationEmailRequested = defineEvent({
  type: "notification.email_requested",
  aggregate: "notification",
  schema: z.object({ notificationId: ulidSchema }),
});
