import { TransientConnectorError } from "@omniseller/connector-core";
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "../../common/context/request-context";
import { ListingPriceWorkerService } from "./listing-price-worker.service";

vi.mock("../../db/tenant-tx", () => ({
  withTenantTx: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
const ctx = systemContext("01J00000000000000000000001");
function harness() {
  const row = {
    requestedBy: "user",
    listingId: "listing",
    storeId: "store",
    expectedPrice: 10000,
    requestedPrice: 12000,
    sentAt: null as Date | null,
  };
  let observed = 10000;
  let lagging = false;
  const finish = vi.fn(async (_tx, _id, _claim, values) => {
    if (values.sentAt) row.sentAt = values.sentAt;
  });
  const update = vi.fn(async () => {
    if (!lagging) observed = 12000;
    return [{ ok: true }];
  });
  const repo = {
    claim: vi.fn(async () => row),
    finish,
    get: vi.fn(async () => ({ status: "processing", claimedAt: new Date() })),
  };
  const principal = {
    user: { id: "user", status: "active" },
    tenant: { status: "active" },
    permissions: ["price:write"],
    storeScope: null,
    warehouseScope: null,
  };
  const users = { loadPrincipal: vi.fn(async () => principal) };
  const stores = { get: vi.fn(async () => ({ store: { status: "active", syncMode: "live", marketplaceInfo: {} } })) };
  const listings = { get: async () => ({ listing: { externalItemId: "item", externalVariantId: "sku" } }) };
  const connector = {
    catalog: {
      getListings: async () => ({
        listings: [{ externalItemId: "item", externalVariantId: "sku", originalPrice: observed }],
      }),
      updatePrices: update,
    },
  };
  const gateway = {
    call: async (_ctx: unknown, _store: unknown, _entry: unknown, fn: (c: unknown, s: unknown) => unknown) =>
      fn(connector, {}),
  };
  const sync = { apply: vi.fn(async () => {}) };
  const worker = new ListingPriceWorkerService(
    {} as never,
    repo as never,
    listings as never,
    stores as never,
    users as never,
    gateway as never,
    sync as never,
  );
  return {
    worker,
    row,
    repo,
    users,
    stores,
    update,
    finish,
    setObserved: (price: number) => {
      observed = price;
    },
    setLagging: () => {
      lagging = true;
    },
  };
}
describe("marketplace price worker", () => {
  it("waits for a competing lease instead of losing the job after a process restart", async () => {
    const h = harness();
    h.repo.claim.mockResolvedValueOnce(undefined as never);
    await expect(h.worker.push(ctx, "change", 0)).rejects.toMatchObject({
      code: "price_lease_busy",
      retryAfterMs: expect.any(Number),
    });
    expect(h.update).not.toHaveBeenCalled();
  });
  it("checks requester permissions, writes once and confirms the returned price", async () => {
    const h = harness();
    await h.worker.push(ctx, "change", 0);
    expect(h.update).toHaveBeenCalledOnce();
    expect(h.users.loadPrincipal).toHaveBeenCalledWith(ctx.tenantId, "user");
    expect(h.finish).toHaveBeenLastCalledWith(
      {},
      "change",
      expect.any(String),
      expect.objectContaining({ status: "succeeded", observedPrice: 12000 }),
    );
  });
  it("never writes over a newer external price, and makes an already matching price idempotent", async () => {
    const h = harness();
    h.setObserved(14000);
    await h.worker.push(ctx, "change", 0);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.finish.mock.calls[0]![3]).toMatchObject({ status: "failed", errorCode: "price_changed" });
    h.setObserved(12000);
    await h.worker.push(ctx, "change", 0);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.finish.mock.calls.at(-1)![3]).toMatchObject({ status: "succeeded" });
  });
  it("retries confirmation after acceptance without writing a second time", async () => {
    const h = harness();
    h.setLagging();
    await expect(h.worker.push(ctx, "change", 0)).rejects.toBeInstanceOf(TransientConnectorError);
    expect(h.row.sentAt).toBeInstanceOf(Date);
    expect(h.finish.mock.calls[0]![3]).toMatchObject({ status: "queued", errorCode: "confirmation_pending" });
    h.setObserved(15000);
    await h.worker.push(ctx, "change", 4);
    expect(h.update).toHaveBeenCalledOnce();
    expect(h.finish.mock.calls.at(-1)![3]).toMatchObject({ status: "failed", errorCode: "confirmation_pending" });
  });
  it("refuses a disabled requester even if the role still grants publishing", async () => {
    const h = harness();
    h.users.loadPrincipal.mockResolvedValueOnce({
      user: { id: "user", status: "disabled" },
      tenant: { status: "active" },
      permissions: ["price:write"],
      storeScope: null,
      warehouseScope: null,
    });
    await h.worker.push(ctx, "change", 0);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.finish.mock.calls[0]![3]).toMatchObject({ status: "failed", errorCode: "permission_revoked" });
  });
  it("refuses revoked permissions and read-only stores before marketplace writes", async () => {
    const h = harness();
    h.users.loadPrincipal.mockResolvedValueOnce({
      user: { id: "user", status: "active" },
      tenant: { status: "active" },
      permissions: [],
      storeScope: null,
      warehouseScope: null,
    });
    await h.worker.push(ctx, "change", 0);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.finish.mock.calls[0]![3]).toMatchObject({ status: "failed", errorCode: "permission_revoked" });
    h.stores.get.mockResolvedValueOnce({ store: { status: "active", syncMode: "read_only", marketplaceInfo: {} } });
    await h.worker.push(ctx, "change", 0);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.finish.mock.calls.at(-1)![3]).toMatchObject({ status: "failed", errorCode: "store_unavailable" });
  });
});
