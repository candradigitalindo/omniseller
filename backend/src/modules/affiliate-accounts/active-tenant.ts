import { PermanentConnectorError } from "@omniseller/connector-core";
import { eq } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { tenant } from "../../db/schema";
/** Serialize credential commits with account closure; never call a marketplace while holding it. */
export async function requireActiveAffiliateTenantIn(tx: Tx, tenantId: string) {
  const [row] = await tx.select({ status: tenant.status }).from(tenant).where(eq(tenant.id, tenantId)).for("share");
  if (row?.status !== "active")
    throw new PermanentConnectorError({ code: "tenant_inactive", message: "Tenant is no longer active" });
}
