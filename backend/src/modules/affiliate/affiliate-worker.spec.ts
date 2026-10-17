import { PermanentConnectorError, TransientConnectorError } from "@omniseller/connector-core";
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "../../common/context/request-context";
import { AffiliateWorkerService } from "./affiliate-worker.service";

vi.mock("../../db/tenant-tx", () => ({
  withTenantTx: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
const ctx = systemContext("01J00000000000000000000001");
function harness() {
  const row = {
    requestedBy: "user",
    storeId: "store",
    expiresAt: new Date(Date.now() + 86_400_000),
    query: { pageSize: 1, cursor: "opaque-next" },
  };
  const repo = {
    claim: vi.fn(async () => row),
    get: vi.fn(async () => ({ status: "running", claimedAt: new Date() })),
    finish: vi.fn(async (_tx: unknown, _id: string, _claim: string, _values: Record<string, unknown>) => {}),
  };
  const users = {
    loadPrincipal: vi.fn(async () => ({
      user: { id: "user", status: "active" },
      tenant: { status: "active" },
      permissions: ["affiliate:read"],
      storeScope: null,
      warehouseScope: null,
    })),
  };
  const stores = {
    get: vi.fn(async () => ({ store: { channel: "shopee", region: "ID", status: "active", syncMode: "read_only" } })),
  };
  const read = vi.fn(async () => ({
    items: [
      {
        externalItemId: "9223372036854775806",
        title: "Kaos",
        externalCampaignId: "11",
        status: "ongoing",
        externalStatus: "Ongoing",
        commissionBasisPoints: 125,
        startsAt: new Date("2026-10-01Z"),
        endsAt: null,
        pendingTerminationAt: null,
        protections: [{ commissionBasisPoints: 200, endsAt: new Date("2026-10-31Z") }],
        maxCommissionBasisPointsToday: 200,
      },
    ],
    total: 2,
    nextCursor: "opaque-third",
  }));
  const gateway = {
    call: vi.fn(async (_ctx: unknown, _id: unknown, _entry: unknown, fn: (c: unknown, s: unknown) => unknown) =>
      fn({ affiliate: { listOpenCampaignProducts: read } }, {}),
    ),
  };
  const worker = new AffiliateWorkerService(
    {} as never,
    repo as never,
    users as never,
    stores as never,
    gateway as never,
  );
  return { row, repo, users, stores, read, gateway, worker };
}
describe("AMS page worker", () => {
  it("reads exactly one requested page from a read-only shop and preserves exact IDs, bps, null periods", async () => {
    const h = harness();
    await h.worker.read(ctx, "request", 0);
    expect(h.read).toHaveBeenCalledExactlyOnceWith({}, h.row.query);
    expect(h.repo.finish.mock.calls[0]).toEqual([
      {},
      "request",
      expect.any(String),
      expect.objectContaining({
        status: "succeeded",
        nextCursor: "opaque-third",
        items: [
          expect.objectContaining({
            externalItemId: "9223372036854775806",
            commissionBasisPoints: 125,
            startsAt: "2026-10-01T00:00:00.000Z",
            endsAt: null,
            protections: [{ commissionBasisPoints: 200, endsAt: "2026-10-31T00:00:00.000Z" }],
          }),
        ],
      }),
    ]);
  });
  it("keeps entitlement failure permanent with an actionable message and no invented empty success", async () => {
    const h = harness();
    h.read.mockRejectedValueOnce(
      new PermanentConnectorError({ code: "error_business", message: "secret upstream body" }),
    );
    await h.worker.read(ctx, "request", 0);
    expect(h.repo.finish.mock.calls[0]![3]).toMatchObject({
      status: "failed",
      errorCode: "error_business",
      errorMessage: expect.stringContaining("persetujuan AMS"),
    });
    expect(JSON.stringify(h.repo.finish.mock.calls)).not.toContain("secret upstream body");
  });
  it("retries transient failures, stops at the last attempt, and waits out another worker's lease", async () => {
    const h = harness();
    const error = new TransientConnectorError({ code: "rate_limit", message: "Slow down", retryAfterMs: 60_000 });
    h.read.mockRejectedValue(error);
    await expect(h.worker.read(ctx, "request", 0)).rejects.toBe(error);
    expect(h.repo.finish.mock.calls[0]![3]).toMatchObject({ status: "queued", finishedAt: null });
    await h.worker.read(ctx, "request", 4);
    expect(h.repo.finish.mock.calls.at(-1)![3]).toMatchObject({ status: "failed" });
    h.repo.claim.mockResolvedValueOnce(undefined as never);
    await expect(h.worker.read(ctx, "request", 0)).rejects.toMatchObject({
      code: "affiliate_lease_busy",
      retryAfterMs: expect.any(Number),
    });
  });
  it("refuses a disabled user or expired request before any marketplace read", async () => {
    const h = harness();
    h.users.loadPrincipal.mockResolvedValueOnce({
      user: { id: "user", status: "disabled" },
      tenant: { status: "active" },
      permissions: ["affiliate:read"],
      storeScope: null,
      warehouseScope: null,
    });
    await h.worker.read(ctx, "request", 0);
    expect(h.repo.finish.mock.calls[0]![3]).toMatchObject({ status: "failed", errorCode: "permission_revoked" });
    h.row.expiresAt = new Date(0);
    await h.worker.read(ctx, "request", 0);
    expect(h.repo.finish.mock.calls.at(-1)![3]).toMatchObject({ status: "failed", errorCode: "expired" });
    expect(h.read).not.toHaveBeenCalled();
  });
});
