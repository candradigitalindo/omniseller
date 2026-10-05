import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl, testRouter } from "@/test/navigation";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import { PRODUCT_ID, productFixture } from "./fixtures";
import { ProductsView } from "./products-view";

describe("ProductsView", () => {
  beforeEach(() => setUrl("/produk"));

  it("lists products with their price range, cost, and listings, and opens their variants", async () => {
    const calls = mockApi({ "GET /v1/products": () => ({ items: [productFixture()], next_cursor: null }) });
    const user = userEvent.setup();
    renderApp(<ProductsView />);

    expect((await screen.findAllByText("Kaos Polos Cotton Combed 30s")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Rp 65.000 – Rp 70.000").length).toBeGreaterThan(0);
    expect(screen.getByText("Rp 35.000 – Rp 36.000")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/v1/products")?.query).toMatchObject({ status: "active", limit: "50" });

    await user.click(screen.getByRole("button", { name: "Tampilkan varian Kaos Polos Cotton Combed 30s" }));
    expect(screen.getByText("KAOS-PTH-L")).toBeInTheDocument();
  });

  it("hides cost from those without finance:read", async () => {
    const hidden = productFixture();
    for (const v of hidden.variants) v.costPrice = null;
    mockApi({ "GET /v1/products": () => ({ items: [hidden], next_cursor: null }) });
    renderApp(<ProductsView />, { me: testMe(["catalog:read"]) });
    await screen.findAllByText("Kaos Polos Cotton Combed 30s");
    expect(screen.queryByRole("columnheader", { name: "HPP" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Tambah produk/ })).toBeNull();
  });

  it("creates a product with its variants and opens it", async () => {
    const calls = mockApi({
      "GET /v1/products": () => ({ items: [], next_cursor: null }),
      "POST /v1/products": () => productFixture(),
    });
    const user = userEvent.setup();
    renderApp(<ProductsView />, { me: testMe(["catalog:read", "catalog:write", "finance:read"]) });

    await user.click(await screen.findByRole("button", { name: "Tambah manual" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nama produk"), "Kaos Polos Cotton Combed 30s");
    await user.type(within(dialog).getByLabelText("SKU induk"), "KAOS");
    await user.type(within(dialog).getByLabelText("SKU varian"), "KAOS-HTM-L");
    await user.type(within(dialog).getByLabelText("Nama varian"), "Hitam, L");
    await user.type(within(dialog).getByLabelText("Harga (Rp)"), "65.000");
    await user.type(within(dialog).getByLabelText("Berat (g)"), "200");
    await user.click(within(dialog).getByRole("button", { name: "Simpan produk" }));
    expect(await within(dialog).findByText("Isi angka rupiah tanpa titik atau koma.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    const price = within(dialog).getByLabelText("Harga (Rp)");
    await user.clear(price);
    await user.type(price, "65000");
    await user.type(within(dialog).getByLabelText("HPP (Rp)"), "35000");
    await user.click(within(dialog).getByRole("button", { name: "Simpan produk" }));
    await waitFor(() => expect(testRouter.push).toHaveBeenCalledWith(`/produk/${PRODUCT_ID}`));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      sku: "KAOS",
      name: "Kaos Polos Cotton Combed 30s",
      variants: [{ sku: "KAOS-HTM-L", name: "Hitam, L", basePrice: 65000, costPrice: 35000, weightG: 200 }],
    });
  });

  it("checks a CSV without saving, then imports the same file", async () => {
    const calls = mockApi({
      "GET /v1/products": () => ({ items: [], next_cursor: null }),
      "POST /v1/products/import": (call) => ({
        rows: 2,
        products: { created: 1, updated: 0 },
        variants: { created: 2, updated: 0 },
        dryRun: (call.body as { dryRun: boolean }).dryRun,
      }),
    });
    const user = userEvent.setup();
    renderApp(<ProductsView />, { me: testMe(["catalog:read", "catalog:write"]) });

    await user.click(await screen.findByRole("button", { name: /Tambah produk/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Impor CSV" }));
    const dialog = await screen.findByRole("dialog");
    const csv = "sku_produk;nama_produk;sku_varian\nKAOS;Kaos;KAOS-L\nKAOS;Kaos;KAOS-M\n";
    await user.upload(
      dialog.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File([csv], "produk.csv", { type: "text/csv" }),
    );
    expect(await within(dialog).findByText(/2 baris siap diimpor: 1 produk baru/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Impor sekarang" }));

    await waitFor(() => expect(calls.filter((c) => c.path === "/v1/products/import")).toHaveLength(2));
    expect(calls.filter((c) => c.path === "/v1/products/import").map((c) => c.body)).toEqual([
      { content: csv, dryRun: true },
      { content: csv, dryRun: false },
    ]);
  });

  it("lists every row problem of a refused file", async () => {
    mockApi({
      "GET /v1/products": () => ({ items: [], next_cursor: null }),
      "POST /v1/products/import": () =>
        problem(422, "validation.failed", "Periksa kembali isian yang ditandai.", {
          errors: [
            { path: "rows.3.sku_varian", message: "SKU varian kosong." },
            { path: "rows.7.harga", message: "Harga harus angka." },
          ],
        }),
    });
    const user = userEvent.setup();
    renderApp(<ProductsView />, { me: testMe(["catalog:read", "catalog:write"]) });
    await user.click(await screen.findByRole("button", { name: /Tambah produk/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Impor CSV" }));
    const dialog = await screen.findByRole("dialog");
    await user.upload(
      dialog.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(["x"], "salah.csv", { type: "text/csv" }),
    );
    expect(await within(dialog).findByText("rows.3.sku_varian: SKU varian kosong.")).toBeInTheDocument();
    expect(within(dialog).getByText("rows.7.harga: Harga harus angka.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Impor sekarang" })).toBeDisabled();
  });
});
