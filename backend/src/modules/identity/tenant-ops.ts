import { eq } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { tenant } from "../../db/schema/identity";

/** Internal operational metadata only. The caller must supply its explicit tenant context. */
export async function tenantForOpsIn(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select({ status: tenant.status, purgeAfter: tenant.purgeAfter, purgedAt: tenant.purgedAt })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .for("share");
  if (!row || row.purgedAt) throw new Error("tenant is missing or already purged");
  return row;
}
