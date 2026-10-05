import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/navigation";
import { mockApi, problem, renderApp } from "@/test/render";
import type { StoreState } from "./migration-meta";
import { MigrationView } from "./migration-view";

const READY = "01JSTORE000000000000000001";
const NOT_READY = "01JSTORE000000000000000002";
const LIVE = "01JSTORE000000000000000003";

const pass = (key: string) => ({ key, ok: true, blocking: true, detail: null });

function stores(): StoreState[] {
  return [
    {
      id: READY,
      name: "Toko Rina Shopee",
      channel: "shopee",
      displayName: "Shopee",
      syncMode: "read_only",
      parallelSince: "2026-10-01T03:00:00.000Z",
      parallelDays: 5,
      orders: { new: 3, shipped: 9 },
      stock: { counts: { match: 40 }, unverified: 0, pulledAt: "2026-10-06T00:30:00.000Z", blocked: null },
      unmappedListings: 0,
      unmappedWarehouses: 0,
      checklist: [
        pass("store_connected"),
        pass("listings_mapped"),
        pass("stock_match"),
        { key: "old_app_revoked", ok: false, blocking: true, detail: "Cabut otorisasi aplikasi lama." },
      ],
      ready: true,
      lastCutover: null,
    },
    {
      id: NOT_READY,
      name: "Toko Rina TTS",
      channel: "tiktokshop",
      displayName: "Tokopedia & Shop",
      syncMode: "read_only",
      parallelSince: "2026-10-05T03:00:00.000Z",
      parallelDays: 1,
      orders: {},
      stock: { counts: { match: 10, differ: 2, unset: 3 }, unverified: 0, pulledAt: null, blocked: null },
      unmappedListings: 4,
      unmappedWarehouses: 0,
      checklist: [
        pass("store_connected"),
        { key: "listings_mapped", ok: false, blocking: true, detail: "4 listing belum terhubung ke produk." },
        { key: "stock_match", ok: false, blocking: true, detail: "2 listing stoknya berbeda." },
        { key: "parallel_days", ok: false, blocking: false, detail: "Mode uji berdampingan baru berjalan 1 hari." },
        { key: "stock_unset", ok: false, blocking: false, detail: "3 listing belum punya stok di OmniSeller." },
      ],
      ready: false,
      lastCutover: null,
    },
    {
      id: LIVE,
      name: "Toko Lama",
      channel: "shopee",
      displayName: "Shopee",
      syncMode: "live",
      parallelSince: null,
      parallelDays: null,
      orders: {},
      stock: { counts: {}, unverified: 0, pulledAt: null, blocked: null },
      unmappedListings: 0,
      unmappedWarehouses: 0,
      checklist: [],
      ready: false,
      lastCutover: {
        id: "01JCUTOVER0000000000000001",
        storeId: LIVE,
        status: "done",
        undoUntil: new Date(Date.now() + 3_600_000).toISOString(),
        canUndo: true,
        checklist: { checks: [], oldAppRevoked: true, stock: { match: 10, differ: 0, unset: 0 } },
        performedBy: null,
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        undoneAt: null,
        undoneBy: null,
      },
    },
  ];
}

function api(cutover: () => unknown = () => ({ items: [] })) {
  return mockApi({
    "GET /v1/migration/parallel": () => ({ items: stores() }),
    "POST /v1/migration/cutover": cutover,
    "POST /v1/migration/cutovers/01JCUTOVER0000000000000001/undo": () => stores()[2]?.lastCutover,
    "POST /v1/listings/sync": () => ({ queued: true }),
    [`GET /v1/migration/stores/${NOT_READY}/stock-comparison`]: (c) => ({
      storeId: NOT_READY,
      pulledAt: null,
      blocked: null,
      counts: { match: 10, differ: 2, unset: 3 },
      items:
        c.query.status === "differ"
          ? [
              {
                listingId: "L1",
                variantId: "V1",
                sku: "KAOS-HTM-L",
                externalSku: "KAOS-HTM-L",
                title: "Kaos Polos Hitam L",
                status: "differ",
                marketplace: 12,
                omniseller: 10,
                difference: -2,
                locations: [],
              },
            ]
          : [],
      more: false,
    }),
    "POST /v1/inventory/initial-stock": (c) => ({
      storeId: NOT_READY,
      dryRun: (c.body as { dryRun: boolean }).dryRun,
      lines: [
        {
          variantId: "V2",
          sku: "TMB-500",
          variantName: "",
          productName: "Tumbler",
          warehouseId: "W1",
          marketplaceQty: 7,
          onHandBefore: 0,
          onHandAfter: 7,
          status: "set",
        },
        {
          variantId: "V3",
          sku: "KAOS-HTM-L",
          variantName: "",
          productName: "Kaos",
          warehouseId: "W1",
          marketplaceQty: 12,
          onHandBefore: 10,
          onHandAfter: 10,
          status: "already_set",
        },
      ],
    }),
  });
}

describe("parallel mode and cutover (L46 steps 4 and 5)", () => {
  beforeEach(() => setUrl("/migrasi?tab=pindah"));

  it("shows each read-only store's orders, stock comparison, and checklist", async () => {
    api();
    renderApp(<MigrationView />);
    expect(await screen.findByText("12 pesanan masuk sejak uji berdampingan")).toBeInTheDocument();
    expect(screen.getByText("2 berbeda")).toBeInTheDocument();
    expect(screen.getByText("4 listing belum terhubung ke produk.")).toBeInTheDocument();
    // advice does not block, and says so
    expect(screen.getByText(/Uji berdampingan minimal 3 hari/).textContent).toContain("saran");
    expect(screen.getByRole("link", { name: "Hubungkan listing" })).toHaveAttribute("href", "/listing");
  });

  it("opens the listings whose stock differs", async () => {
    api();
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    const card = (await screen.findByText("Toko Rina TTS", { selector: "div" })).closest(
      "[data-slot=card]",
    ) as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Lihat perbandingan stok" }));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("KAOS-HTM-L")).toBeInTheDocument();
    expect(within(sheet).getByText("-2")).toBeInTheDocument();
  });

  it("takes stock never set from the store after showing what it would do", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    await user.click(await screen.findByRole("button", { name: "Ambil stok awal dari toko" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/1 stok akan ditetapkan; 1 lainnya/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Tetapkan 1 stok" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/v1/inventory/initial-stock").map((c) => c.body)).toEqual([
        { storeId: NOT_READY, dryRun: true },
        { storeId: NOT_READY, dryRun: false },
      ]),
    );
  });

  it("moves the ready stores live after the old app is revoked", async () => {
    const calls = api(() => ({ items: [stores()[2]?.lastCutover] }));
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    const ready = await screen.findByRole("checkbox", { name: /Toko Rina Shopee/ });
    expect(ready).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Toko Rina TTS/ })).toBeDisabled();
    const move = screen.getByRole("button", { name: "Pindah sepenuhnya ke OmniSeller" });
    expect(move).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /Saya sudah mencabut otorisasi/ }));
    await user.click(move);
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/v1/migration/cutover")?.body).toEqual({
        storeIds: [READY],
        oldAppRevoked: true,
      }),
    );
    expect(await screen.findByText("1 toko kini aktif penuh di OmniSeller.")).toBeInTheDocument();
  });

  it("says why nothing moved when a check fails at the last moment", async () => {
    api(() => problem(409, "cutover.checklist_failed", "Checklist belum lengkap."));
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    await user.click(await screen.findByRole("checkbox", { name: /Saya sudah mencabut otorisasi/ }));
    await user.click(screen.getByRole("button", { name: "Pindah sepenuhnya ke OmniSeller" }));
    expect(await screen.findByText(/belum ada toko yang dipindah/)).toBeInTheDocument();
  });

  it("puts a store back in parallel mode within 24 hours", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    await user.click(await screen.findByRole("button", { name: "Kembalikan ke mode uji" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/undo"))).toBe(true));
    expect(await screen.findByText("Toko Lama kembali ke mode uji berdampingan.")).toBeInTheDocument();
  });
});
