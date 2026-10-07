import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/**
 * A courier cut-off, courier holiday, or the operating hours changed (backend doc 8.31): every order to
 * ship gets its internal deadline again (job `order.internal_deadlines`).
 */
export const courierCalendarChanged = defineEvent({
  type: "courier_calendar.changed",
  aggregate: "tenant",
  schema: z.object({}),
});
