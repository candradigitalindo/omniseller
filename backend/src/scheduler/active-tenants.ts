import { sql } from "drizzle-orm";

/**
 * Rows of businesses that are working: an account closing (backend doc 8.36) hears no more alerts or
 * reminders, and a closed one has nothing left. For scans whose rows carry `tenant_id`.
 */
export const OF_ACTIVE_TENANT = sql.raw(`tenant_id IN (SELECT id FROM tenant WHERE status = 'active')`);
