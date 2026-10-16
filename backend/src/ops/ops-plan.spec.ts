import { newId } from "@omniseller/shared";
import { describe, expect, it } from "vitest";
import { COMMANDS, guardOps, parseOpsCommand } from "./ops-plan";

const tenant = newId();
describe("operational command boundary", () => {
  it("parses the seven commands and bounds every batch", () => {
    const inputs = [
      [
        "webhook:replay",
        "--tenant",
        tenant,
        "--source",
        "shopee",
        "--since",
        "2026-09-30T00:00Z",
        "--force",
        "--limit",
        "12",
      ],
      ["stock:push", "--tenant", tenant, "--variant", newId(), "--warehouse", newId()],
      ["partition:maintain"],
      ["crypto:rotate-dek", "--tenant", tenant],
      ["tenant:purge", "--tenant", tenant],
      ["jobs:dlq", "--queue", "mp.outbound"],
      ["jobs:retry", "--queue", "webhook", "--all"],
    ];
    expect(inputs.map((args) => parseOpsCommand(args).name)).toEqual(COMMANDS);
    const replay = parseOpsCommand(inputs[0]!);
    expect(replay).toMatchObject({ tenantId: tenant, force: true, limit: 12, since: new Date("2026-09-30T00:00Z") });
    expect(parseOpsCommand(["jobs:retry", "--queue", "webhook", "--id", "webhook.process|abc"]).id).toBe(
      "webhook.process|abc",
    );
  });

  it.each([
    [],
    ["purge"],
    ["tenant:purge"],
    ["tenant:purge", "--tenant", "bad"],
    ["tenant:purge", "--tenant", tenant, "--force"],
    ["partition:maintain", "unexpected"],
    ["jobs:retry", "--queue", "webhook"],
    ["jobs:retry", "--queue", "webhook", "--all", "--id", "job"],
    ["jobs:dlq", "--queue", "webhook.dlq"],
    ["jobs:dlq", "--queue", "webhook", "--limit", "1001"],
    ["jobs:dlq", "--queue", "webhook", "--limit", "0"],
    ["jobs:dlq", "--queue", "webhook", "--limit", "1.5"],
    ["jobs:retry", "--queue", "webhook", "--id", "bad\njob"],
    ["webhook:replay", "--tenant", tenant, "--source", "shopee"],
    ["webhook:replay", "--tenant", tenant, "--source", "manual", "--since", "2026-09-30T00:00Z"],
    ["webhook:replay", "--tenant", tenant, "--source", "shopee", "--since", "2026-09-30T00:00"],
    ["webhook:replay", "--tenant", tenant, "--source", "shopee", "--since", "2026-02-30T00:00Z"],
    ["webhook:replay", "--tenant", tenant, "--id", newId(), "--source", "shopee"],
    ["stock:push", "--tenant", tenant, "--variant", newId()],
  ])("rejects malformed or ambiguous arguments: %j", (...args) => {
    expect(() => parseOpsCommand(args)).toThrow();
  });

  it("requires a known environment and production confirmation only for mutations", () => {
    for (const args of [
      ["partition:maintain"],
      ["jobs:retry", "--queue", "notify", "--all"],
      ["crypto:rotate-dek", "--tenant", tenant],
    ]) {
      const command = parseOpsCommand(args);
      expect(() => guardOps(command, {})).toThrow("NODE_ENV");
      expect(() => guardOps(command, { NODE_ENV: "prod", OPS_CONFIRM: "1" })).toThrow("NODE_ENV");
      expect(() => guardOps(command, { NODE_ENV: "production", OPS_CONFIRM: "true" })).toThrow("OPS_CONFIRM");
      expect(() => guardOps(command, { NODE_ENV: "production", OPS_CONFIRM: "1" })).not.toThrow();
      expect(() => guardOps({ ...command, dryRun: true }, { NODE_ENV: "production" })).not.toThrow();
    }
    expect(() =>
      guardOps(parseOpsCommand(["jobs:dlq", "--queue", "notify"]), { NODE_ENV: "production" }),
    ).not.toThrow();
  });
});
