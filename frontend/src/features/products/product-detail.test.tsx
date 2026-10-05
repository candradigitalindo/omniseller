import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import { PRODUCT_ID, productFixture } from "./fixtures";
import { ProductDetailView } from "./product-detail";

const WRITER = testMe(["catalog:read", "catalog:write", "catalog:map", "finance:read"]);

function withEtag(body: unknown, etag: string) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", etag } });
}

describe("ProductDetailView", () => {
  beforeEach(() => setUrl(`/produk/${PRODUCT_ID}`));

  it("saves the information with the version it was read at", async () => {
    const calls = mockApi({
      [`GET /v1/products/${PRODUCT_ID}`]: () => withEtag(productFixture(), '"7"'),
      [`PATCH /v1/products/${PRODUCT_ID}`]: () => productFixture({ brand: "Rina" }),
    });
    const user = userEvent.setup();
    renderApp(<ProductDetailView id={PRODUCT_ID} />, { me: WRITER });

    const save = await screen.findByRole("button", { name: "Simpan perubahan" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Merek"), "Rina");
    await user.type(screen.getByLabelText("Gambar"), "http://tidak-aman.test/a.jpg");
    await user.click(save);
    expect(await screen.findByText("Alamat gambar harus https: http://tidak-aman.test/a.jpg")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Gambar"));
    await user.type(screen.getByLabelText("Gambar"), "https://cdn.test/kaos.jpg");
    await user.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toMatchObject({
      brand: "Rina",
      imageUrls: ["https://cdn.test/kaos.jpg"],
      attributeNames: ["Warna", "Ukuran"],
    });
    expect(patch.headers?.["if-match"]).toBe('"7"');
  });

  it("saves one variant row once something in it changed", async () => {
    setUrl(`/produk/${PRODUCT_ID}?tab=variants`);
    const calls = mockApi({
      [`GET /v1/products/${PRODUCT_ID}`]: () => productFixture(),
      [`PATCH /v1/products/${PRODUCT_ID}/variants/01JVARIANT0000000000000001`]: () => productFixture().variants[0],
    });
    const user = userEvent.setup();
    renderApp(<ProductDetailView id={PRODUCT_ID} />, { me: WRITER });

    const price = await screen.findByLabelText("Harga (Rp) KAOS-HTM-L");
    expect(screen.queryByRole("button", { name: "Simpan" })).toBeNull();
    await user.clear(price);
    await user.type(price, "67000");
    await user.click(screen.getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
      sku: "KAOS-HTM-L",
      basePrice: 67000,
      costPrice: 35000,
      weightG: 200,
      status: "active",
    });
  });

  it("makes barcodes only for variants without one", async () => {
    setUrl(`/produk/${PRODUCT_ID}?tab=variants`);
    const calls = mockApi({
      [`GET /v1/products/${PRODUCT_ID}`]: () => productFixture(),
      "POST /v1/products/barcodes": () => ({
        items: [
          { variantId: "01JVARIANT0000000000000001", sku: "KAOS-HTM-L", barcode: "2000000000022", generated: true },
        ],
      }),
    });
    const user = userEvent.setup();
    renderApp(<ProductDetailView id={PRODUCT_ID} />, { me: WRITER });
    await user.click(await screen.findByRole("button", { name: "Buat barcode (1)" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/products/barcodes")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/products/barcodes")?.body).toEqual({
      variantIds: ["01JVARIANT0000000000000001"],
    });
  });

  it("keeps the tab in the URL and explains a refused delete", async () => {
    mockApi({
      [`GET /v1/products/${PRODUCT_ID}`]: () => productFixture(),
      [`DELETE /v1/products/${PRODUCT_ID}`]: () =>
        problem(409, "product.has_listings", "Produk ini masih punya listing tertaut."),
      [`GET /v1/products/${PRODUCT_ID}/history`]: () => ({
        items: [
          {
            id: "01JAUDIT00000000000000001",
            at: "2026-10-04T03:00:00.000Z",
            actor: { type: "user", id: "01JUSER0000000000000000000", name: "Rina Wulandari" },
            action: "updated",
            target: { type: "variant", id: "01JVARIANT0000000000000001", sku: "KAOS-HTM-L", name: "Hitam, L" },
            changes: [
              { field: "basePrice", label: "Harga", before: 60000, after: 65000 },
              { field: "costPrice", label: "HPP", before: null, after: null, hidden: true },
            ],
          },
        ],
        next_cursor: null,
      }),
    });
    const user = userEvent.setup();
    renderApp(<ProductDetailView id={PRODUCT_ID} />, { me: WRITER });

    await user.click(await screen.findByRole("tab", { name: "Riwayat" }));
    expect(currentUrl()).toBe(`/produk/${PRODUCT_ID}?tab=history`);
    expect(await screen.findByText("Varian KAOS-HTM-L diubah")).toBeInTheDocument();
    expect(screen.getByText(/Rp 60\.000 → Rp 65\.000/)).toBeInTheDocument();
    expect(screen.getByText("disembunyikan")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Aksi lain" }));
    await user.click(await screen.findByRole("menuitem", { name: "Hapus produk" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Hapus produk" }));
    expect(await screen.findByText("Produk ini masih punya listing tertaut.")).toBeInTheDocument();
  });
});
