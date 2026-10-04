import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DRIZZLE_DIR, migrate } from "../../src/db/migrate";
import { withTenantTx } from "../../src/db/tenant-tx";
import { createTenant } from "../setup/factories";
import { testHandles } from "../setup/handles";

const h = testHandles();

describe("migration runner (ADR-027)", () => {
  it("is idempotent: a second run applies no versioned migration and creates no partition", async () => {
    const result = await migrate(h.infra.urls.migrator);
    expect(result.applied).toEqual([]);
    expect(result.repeatables).toEqual([
      "10_functions.sql",
      "15_views.sql",
      "20_triggers.sql",
      "30_policies.sql",
      "40_grants.sql",
      "90_seeds.sql",
    ]);
    expect(result.partitionsCreated).toBe(0);
  });

  it("refuses to run when an applied migration was edited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omniseller-migrate-"));
    await cp(DRIZZLE_DIR, dir, { recursive: true });
    await writeFile(join(dir, "migrations", "0001_core.sql"), "-- edited\n", { flag: "a" });
    await expect(migrate(h.infra.urls.migrator, { dir })).rejects.toThrow(
      /0001_core.sql was changed after it was applied/,
    );
  });

  it("gives the built-in roles of a business created earlier the permissions added since (returns, 0016)", async () => {
    const { tenantId, ctx } = await createTenant(h.api);
    // built-in roles as an older signup left them: nothing about returns
    await withTenantTx(h.api, ctx, async (tx) => {
      for (const name of ["Admin", "CS", "Gudang", "Viewer"]) {
        await tx.execute(
          sql`INSERT INTO role (id, tenant_id, name, is_system) VALUES (${newId()}, ${tenantId}, ${name}, true)`,
        );
      }
    });
    await migrate(h.infra.urls.migrator);
    const granted = await withTenantTx(h.api, ctx, (tx) =>
      tx.execute<{ name: string; code: string }>(sql`
        SELECT r.name, p.code FROM role r JOIN role_permission rp ON rp.role_id = r.id
          JOIN permission p ON p.id = rp.permission_id
         WHERE p.code LIKE 'return:%' ORDER BY 1, 2`),
    );
    expect(granted.rows).toEqual([
      { name: "Admin", code: "return:receive" },
      { name: "Admin", code: "return:respond" },
      { name: "CS", code: "return:respond" },
      { name: "Gudang", code: "return:receive" },
    ]);
  });
});
