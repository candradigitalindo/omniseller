import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DRIZZLE_DIR, migrate } from "../../src/db/migrate";
import { testHandles } from "../setup/handles";

const h = testHandles();

describe("migration runner (ADR-027)", () => {
  it("is idempotent: a second run applies no versioned migration and creates no partition", async () => {
    const result = await migrate(h.infra.urls.migrator);
    expect(result.applied).toEqual([]);
    expect(result.repeatables).toEqual([
      "10_functions.sql",
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
});
