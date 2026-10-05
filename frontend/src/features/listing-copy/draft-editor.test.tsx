import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/navigation";
import { mockApi, problem, renderApp } from "@/test/render";
import type { Draft } from "./copy-meta";
import { DraftEditor } from "./draft-editor";
import { categoryFixture, DRAFT_ID, draftFixture, stores, TIKTOK_STORE } from "./fixtures";

const withEtag = (body: unknown, etag: string) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", etag } });

function api(draft: Draft = draftFixture(), save: () => unknown = () => draftFixture({ rowVersion: 4 })) {
  return mockApi({
    "GET /v1/stores": () => stores,
    [`GET /v1/listing-drafts/${DRAFT_ID}`]: () => withEtag(draft, `"${draft.rowVersion}"`),
    [`PATCH /v1/listing-drafts/${DRAFT_ID}`]: save,
    [`GET /v1/stores/${TIKTOK_STORE}/categories/601226`]: () => categoryFixture(),
    [`GET /v1/stores/${TIKTOK_STORE}/categories`]: () => ({
      items: [
        {
          categoryId: "601230",
          parentId: null,
          name: "Kaos Wanita",
          path: "Kaos Wanita",
          isLeaf: true,
          permitted: true,
        },
      ],
      total: 1,
      refreshedAt: "2026-10-06T00:00:00.000Z",
    }),
    "POST /v1/listing-drafts/category": () => ({ updated: 1 }),
    "POST /v1/listing-drafts/publish": () => ({ queued: [DRAFT_ID], refused: [] }),
  });
}

describe("DraftEditor", () => {
  beforeEach(() => setUrl(`/listing/salin/draf/${DRAFT_ID}`));

  it("shows what blocks publishing, and saves only the changes with If-Match", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<DraftEditor id={DRAFT_ID} />);

    expect(await screen.findByText("1 hal harus diperbaiki sebelum terbit")).toBeInTheDocument();
    expect(screen.getByText("1 catatan untuk diketahui")).toBeInTheDocument();
    // the blocking attribute is required in this category and says why next to it
    const imported = await screen.findByRole("combobox", { name: /Barang Impor/ });
    expect(imported).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Terbitkan" })).toBeDisabled();

    await user.clear(screen.getByLabelText("Nama produk"));
    await user.type(screen.getByLabelText("Nama produk"), "Kaos Polos Premium Katun Combed 30s");
    await user.click(imported);
    await user.click(await screen.findByRole("option", { name: "Ya" }));
    // "Berat Kain" is required once the product is imported
    const fabric = await screen.findByLabelText(/Berat Kain/);
    await user.type(fabric, "180");
    await user.click(screen.getByRole("button", { name: "Geser foto 2 ke kiri" }));
    await user.clear(screen.getByRole("textbox", { name: "SKU Hitam L" }));
    await user.type(screen.getByRole("textbox", { name: "SKU Hitam L" }), "KAOS-HTM-L");
    expect(screen.getByText("Ada perubahan yang belum disimpan.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.headers?.["if-match"]).toBe('"3"');
    expect(patch?.body).toEqual({
      title: "Kaos Polos Premium Katun Combed 30s",
      attributes: [
        { attributeId: "100134", values: [{ valueId: "1234" }] },
        { attributeId: "100200", values: [{ name: "180", unit: "g" }] },
        { attributeId: "102254", values: [{ valueId: "1000059" }] },
      ],
      images: ["https://cf.shopee.co.id/file/kaos-2", "https://cf.shopee.co.id/file/kaos-1"],
      variants: [
        { key: "9101", sku: "KAOS-HTM-M", price: 60_500, options: ["Hitam", "M"] },
        { key: "9102", sku: "KAOS-HTM-L", price: 62_700, options: ["Hitam", "L"] },
      ],
    });
  });

  it("says when someone else saved first", async () => {
    api(draftFixture(), () => problem(412, "row.stale", "Data sudah berubah."));
    const user = userEvent.setup();
    renderApp(<DraftEditor id={DRAFT_ID} />);
    await user.type(await screen.findByLabelText("Nama produk"), " Baru");
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    expect(await screen.findByText(/baru saja diubah orang lain/)).toBeInTheDocument();
  });

  it("publishes a draft without blocking problems, but not while it has unsaved changes", async () => {
    const calls = api(draftFixture({ blockingProblems: 0, problems: [] }));
    const user = userEvent.setup();
    renderApp(<DraftEditor id={DRAFT_ID} />);
    const publish = await screen.findByRole("button", { name: "Terbitkan" });
    expect(publish).toBeEnabled();
    await user.type(screen.getByLabelText("Nama produk"), "!");
    expect(publish).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Batalkan perubahan" }));
    expect(publish).toBeEnabled();
    await user.click(publish);
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/v1/listing-drafts/publish")?.body).toEqual({ draftIds: [DRAFT_ID] }),
    );
  });

  it("moves the draft to another category", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<DraftEditor id={DRAFT_ID} />);
    await user.click(await screen.findByRole("button", { name: "Ganti kategori" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: /Kaos Wanita/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/v1/listing-drafts/category")?.body).toEqual({
        draftIds: [DRAFT_ID],
        categoryId: "601230",
      }),
    );
  });

  it("only shows a published draft", async () => {
    api(draftFixture({ status: "published", externalTargetItemId: "1729000000000000001", problems: [] }));
    renderApp(<DraftEditor id={DRAFT_ID} />);
    expect(await screen.findByText("Produk di toko tujuan: 1729000000000000001")).toBeInTheDocument();
    expect(screen.getByLabelText("Nama produk")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Simpan perubahan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terbitkan" })).not.toBeInTheDocument();
  });
});
