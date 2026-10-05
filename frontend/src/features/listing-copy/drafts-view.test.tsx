import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { mockApi, renderApp } from "@/test/render";
import { DraftsView } from "./drafts-view";
import { categoryFixture, DRAFT_ID, draftFixture, draftItem, SHOPEE_STORE, stores, TIKTOK_STORE } from "./fixtures";

const READY = "01JDRAFT000000000000000002";
const OTHER_STORE = "01JDRAFT000000000000000003";
const drafts = [
  draftItem(),
  draftItem({ id: READY, title: "Topi Rajut Wol Musim Dingin", blockingProblems: 0, warnings: 0 }),
  draftItem({ id: OTHER_STORE, title: "Totebag Kanvas", targetStoreId: SHOPEE_STORE, blockingProblems: 0 }),
];

function api(over: Record<string, (c: { query: Record<string, string>; body: unknown }) => unknown> = {}) {
  return mockApi({
    "GET /v1/stores": () => stores,
    "GET /v1/listing-drafts": () => ({ items: drafts, next_cursor: null }),
    [`GET /v1/listing-drafts/${DRAFT_ID}`]: () => draftFixture(),
    [`GET /v1/stores/${TIKTOK_STORE}/categories`]: (c) =>
      c.query.parentId === "601152"
        ? {
            items: [
              {
                categoryId: "601226",
                parentId: "601152",
                name: "Kaos",
                path: "Pakaian Pria > Kaos",
                isLeaf: true,
                permitted: true,
              },
              {
                categoryId: "601227",
                parentId: "601152",
                name: "Jaket",
                path: "Pakaian Pria > Jaket",
                isLeaf: true,
                permitted: false,
              },
            ],
            total: 3,
            refreshedAt: "2026-10-06T00:00:00.000Z",
          }
        : {
            items: [
              {
                categoryId: "601152",
                parentId: null,
                name: "Pakaian Pria",
                path: "Pakaian Pria",
                isLeaf: false,
                permitted: true,
              },
            ],
            total: 3,
            refreshedAt: "2026-10-06T00:00:00.000Z",
          },
    [`GET /v1/stores/${TIKTOK_STORE}/categories/601226`]: () => categoryFixture(),
    "POST /v1/listing-drafts/publish": () => ({ queued: [READY], refused: [] }),
    "POST /v1/listing-drafts/category": () => ({ updated: 2 }),
    "POST /v1/listing-drafts/attributes": () => ({
      updated: [DRAFT_ID],
      skipped: [{ draftId: READY, reason: "Kategori draf ini tidak punya atribut Barang Impor." }],
    }),
    [`DELETE /v1/listing-drafts/${DRAFT_ID}`]: () => undefined,
    [`DELETE /v1/listing-drafts/${READY}`]: () => undefined,
    ...over,
  });
}

const draftCalls = (calls: { method: string; path: string; query: Record<string, string> }[]) =>
  calls.filter((c) => c.method === "GET" && c.path === "/v1/listing-drafts");

async function pick(user: ReturnType<typeof userEvent.setup>, ...titles: string[]) {
  for (const title of titles) await user.click(screen.getAllByRole("checkbox", { name: `Pilih ${title}` })[0]!);
}

describe("DraftsView", () => {
  beforeEach(() => setUrl("/listing/salin?tab=draf"));

  it("lists drafts with their problems and filters them by queue", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<DraftsView />);
    expect((await screen.findAllByText("1 perlu diperbaiki")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Siap").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Kaos Polos Katun Combed 30s Unisex" })[0]).toHaveAttribute(
      "href",
      `/listing/salin/draf/${DRAFT_ID}`,
    );
    await user.click(screen.getByRole("button", { name: "Perlu diperbaiki" }));
    expect(currentUrl()).toBe("/listing/salin?tab=draf&view=fix");
    await waitFor(() => expect(draftCalls(calls).at(-1)?.query).toMatchObject({ status: "draft", blocking: "true" }));
  });

  it("publishes only the drafts that can go", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<DraftsView />);
    await screen.findAllByText("1 perlu diperbaiki");
    await pick(user, "Kaos Polos Katun Combed 30s Unisex", "Topi Rajut Wol Musim Dingin");
    await user.click(screen.getByRole("button", { name: "Terbitkan (1)" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/listing-drafts/publish")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/listing-drafts/publish")?.body).toEqual({ draftIds: [READY] });
    expect(await screen.findByText("1 draf sedang diterbitkan.")).toBeInTheDocument();
  });

  it("names the drafts the api refuses", async () => {
    api({
      "POST /v1/listing-drafts/publish": () => ({
        queued: [],
        refused: [{ draftId: READY, code: "store.not_active", message: "Toko tujuan perlu dihubungkan ulang." }],
      }),
    });
    const user = userEvent.setup();
    renderApp(<DraftsView />);
    await screen.findAllByText("1 perlu diperbaiki");
    await pick(user, "Topi Rajut Wol Musim Dingin");
    await user.click(screen.getByRole("button", { name: "Terbitkan (1)" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 draf tidak diterbitkan:");
    expect(alert).toHaveTextContent("Topi Rajut Wol Musim Dingin: Toko tujuan perlu dihubungkan ulang.");
  });

  it("moves drafts of one store to a final category the shop may use", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<DraftsView />);
    await screen.findAllByText("1 perlu diperbaiki");
    await pick(user, "Kaos Polos Katun Combed 30s Unisex", "Totebag Kanvas");
    // two target stores: one category list does not fit both
    expect(screen.getByRole("button", { name: "Ganti kategori" })).toBeDisabled();
    expect(screen.getByText(/hanya untuk draf satu toko tujuan/)).toBeInTheDocument();
    await pick(user, "Totebag Kanvas", "Topi Rajut Wol Musim Dingin");
    await user.click(screen.getByRole("button", { name: "Ganti kategori" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "Pakaian Pria" }));
    expect(await within(dialog).findByRole("button", { name: /Jaket/ })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: /Kaos/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/listing-drafts/category")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/listing-drafts/category")?.body).toEqual({
      draftIds: [DRAFT_ID, READY],
      categoryId: "601226",
    });
  });

  it("fills one attribute in many drafts and names the ones skipped", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<DraftsView />);
    await screen.findAllByText("1 perlu diperbaiki");
    await pick(user, "Kaos Polos Katun Combed 30s Unisex", "Topi Rajut Wol Musim Dingin");
    await user.click(screen.getByRole("button", { name: "Isi atribut" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("combobox", { name: "Atribut" }));
    await user.click(await screen.findByRole("option", { name: "Barang Impor (wajib)" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Nilai" }));
    await user.click(await screen.findByRole("option", { name: "Tidak" }));
    await user.click(within(dialog).getByRole("button", { name: "Terapkan" }));
    expect(
      await within(dialog).findByText(/Topi Rajut Wol Musim Dingin: Kategori draf ini tidak punya/),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/v1/listing-drafts/attributes")?.body).toEqual({
      draftIds: [DRAFT_ID, READY],
      attributeId: "102254",
      values: [{ valueId: "1000060" }],
    });
  });

  it("deletes drafts after asking", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<DraftsView />);
    await screen.findAllByText("1 perlu diperbaiki");
    await pick(user, "Kaos Polos Katun Combed 30s Unisex", "Topi Rajut Wol Musim Dingin");
    await user.click(screen.getByRole("button", { name: "Hapus" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Hapus 2 draf?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Hapus" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2));
    expect(await screen.findByText("2 draf dihapus.")).toBeInTheDocument();
  });
});
