import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { components } from "@/lib/api/schema";
import { mockApi, renderApp, testMe } from "@/test/render";
import { AffiliateProductsView } from "./affiliate-products-view";

type Result = components["schemas"]["AffiliateProductsDto_Output"];
const storeId = "01JSTORE000000000000000001";
const path = `/v1/stores/${storeId}/affiliate/products`;
const base: Result = {
  id: "01JQUERY00000000000000001",
  storeId,
  query: { pageSize: 8, sortBy: "-commission_rate" },
  status: "succeeded",
  total: 2,
  nextCursor: "opaque-next",
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-10-17T00:00:00.000Z",
  finishedAt: "2026-10-17T00:00:01.000Z",
  expiresAt: "2026-10-18T00:00:00.000Z",
  items: [
    {
      externalItemId: "9223372036854775806",
      externalCampaignId: "123",
      title: "Kaos Merah",
      status: "ongoing",
      externalStatus: "Ongoing",
      commissionBasisPoints: 125,
      startsAt: "2026-10-01T00:00:00.000Z",
      endsAt: null,
      pendingTerminationAt: null,
      protections: [{ commissionBasisPoints: 200, endsAt: "2026-10-31T00:00:00.000Z" }],
      maxCommissionBasisPointsToday: null,
    },
  ],
};
function setup(initial: Result | null = null) {
  let current = initial;
  const saved = new Map<string, Result>();
  if (initial) saved.set(initial.id, initial);
  return mockApi({
    "GET /v1/stores": () => ({
      items: [
        { id: storeId, name: "Toko Utama", channel: "shopee", region: "ID", status: "active", syncMode: "read_only" },
      ],
    }),
    [`GET ${path}`]: (call) => ({ request: call.query.requestId ? saved.get(call.query.requestId) : current }),
    [`POST ${path}`]: (call) => {
      const query = call.body as Result["query"];
      current = {
        ...base,
        query,
        ...(query.cursor
          ? {
              id: "01JQUERY00000000000000002",
              nextCursor: null,
              items: [{ ...base.items[0]!, externalItemId: "2", title: "Kaos Biru" }],
            }
          : {}),
      };
      saved.set(current.id, current);
      return { ...current, status: "queued", items: [], total: null };
    },
  });
}
describe("AMS products", () => {
  it("submits typed search with an idempotency key, reads rates and periods, and follows an opaque cursor", async () => {
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<AffiliateProductsView />, { me: testMe(["affiliate:read"]) });
    await user.click(await screen.findByRole("button", { name: "Cari produk" }));
    await user.type(screen.getByLabelText("Kata kunci"), "Kaos");
    await user.click(screen.getByRole("button", { name: "Tampilkan produk" }));
    await screen.findByRole("button", { name: "Detail Kaos Merah" });
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      body: { pageSize: 8, sortBy: "-commission_rate", search: { by: "name", value: "Kaos" } },
      headers: { "idempotency-key": expect.any(String) },
    });
    expect(screen.getByText("1,25%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Detail Kaos Merah" }));
    const dialog = screen.getByRole("dialog", { name: "Detail produk AMS" });
    expect(within(dialog).getByText("9223372036854775806")).toBeInTheDocument();
    expect(within(dialog).getByText("Tidak disediakan")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("tab", { name: "Periode" }));
    expect(within(dialog).getByText("Tanpa batas waktu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Berikutnya" }));
    await screen.findByText("Kaos Biru");
    expect(calls.filter((c) => c.method === "POST").at(-1)?.body).toMatchObject({
      cursor: "opaque-next",
      sortBy: "-commission_rate",
      search: { by: "name", value: "Kaos" },
    });
    await user.click(screen.getByRole("button", { name: "Sebelumnya" }));
    await screen.findByText("Kaos Merah");
  });
  it("shows actionable entitlement errors and retries without reporting an empty success", async () => {
    const calls = setup({
      ...base,
      status: "failed",
      items: [],
      total: null,
      errorMessage: "Periksa persetujuan AMS di Seller Center.",
    });
    const user = userEvent.setup();
    renderApp(<AffiliateProductsView />);
    await screen.findByText("Periksa persetujuan AMS di Seller Center.");
    expect(screen.queryByText("Produk tidak ditemukan")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba kembali" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await screen.findByText("Kaos Merah");
  });
  it("keeps the screen and network requests behind the dynamic affiliate permission", async () => {
    const calls = setup();
    renderApp(<AffiliateProductsView />, { me: testMe(["catalog:read"]) });
    expect(screen.getByText("Anda belum memiliki izin melihat affiliate.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
