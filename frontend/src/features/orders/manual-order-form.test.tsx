import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl, testRouter } from "@/test/navigation";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import { ManualOrderForm } from "./manual-order-form";

const PRODUCT = {
  id: "01JPRODUCT0000000000000001",
  sku: "KAOS",
  name: "Kaos Polos",
  status: "active",
  variants: [
    { id: "01JVARIANT0000000000000001", sku: "KAOS-HTM", name: "Hitam", basePrice: 65_000, status: "active" },
    { id: "01JVARIANT0000000000000002", sku: "KAOS-OLD", name: "Lama", basePrice: 50_000, status: "archived" },
  ],
};
const STOCK = {
  items: [
    {
      id: "01JVARIANT0000000000000001",
      sku: "KAOS-HTM",
      warehouses: [
        { warehouseId: "01JWAREHOUSE00000000000001", available: 3 },
        { warehouseId: "01JWAREHOUSE00000000000002", available: 1 },
      ],
    },
  ],
  next_cursor: null,
};
const ORDER = { id: "01JORDER000000000000000001", externalOrderId: "MN-2610-0001" };

function api(create: () => unknown = () => ORDER) {
  return mockApi({
    "GET /v1/stores": () => ({
      items: [
        { id: "01JSTORE000000000000000001", name: "WhatsApp", channel: "manual", status: "active", syncMode: "live" },
        {
          id: "01JSTORE000000000000000002",
          name: "Toko Shopee",
          channel: "shopee",
          status: "active",
          syncMode: "live",
        },
      ],
    }),
    "GET /v1/warehouses": () => ({
      items: [
        { id: "01JWAREHOUSE00000000000001", name: "Gudang Jakarta" },
        { id: "01JWAREHOUSE00000000000002", name: "Gudang Surabaya" },
      ],
    }),
    "GET /v1/products": () => ({ items: [PRODUCT], next_cursor: null }),
    "GET /v1/inventory": () => STOCK,
    "GET /v1/products/lookup": (c) =>
      c.query.code === "8991234567890"
        ? { matchedBy: "barcode", variant: PRODUCT.variants[0], product: PRODUCT }
        : problem(404, "product.not_found", "Produk tidak ditemukan."),
    [`GET /v1/products/${PRODUCT.id}`]: () => PRODUCT,
    "POST /v1/orders/manual": create,
  });
}

async function addShirt(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Tambah barang"), "kaos");
  await user.click(await screen.findByRole("button", { name: /Kaos Polos · Hitam/ }));
}

describe("ManualOrderForm (FR-ORD-09)", () => {
  beforeEach(() => setUrl("/pesanan/baru"));

  it("adds items at their price, shows the stock, and creates the order once", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<ManualOrderForm />);

    await user.type(screen.getByLabelText("Tambah barang"), "kaos");
    const results = await screen.findByRole("list", { name: "Hasil pencarian" });
    // archived variants are not offered; the best warehouse's stock is
    expect(within(results).getAllByRole("button")).toHaveLength(1);
    expect(within(results).getByText("Stok 3")).toBeInTheDocument();
    await user.click(within(results).getByRole("button"));
    // the list goes at once: results of the last word must not take the next click
    expect(screen.queryByRole("list", { name: "Hasil pencarian" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Tambah barang"), "kaos");
    await screen.findByRole("list", { name: "Hasil pencarian" });
    await user.type(screen.getByLabelText("Tambah barang"), " h");
    expect(screen.queryByRole("list", { name: "Hasil pencarian" })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Tambah barang"));
    await addShirt(user);
    expect(screen.getByLabelText("Jumlah")).toHaveValue("2");
    expect(screen.getByText("Stok siap jual 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tambah KAOS-HTM" }));
    await user.click(screen.getByRole("button", { name: "Tambah KAOS-HTM" }));
    // more than the stock: said, not refused
    expect(screen.getByText(/Stok siap jual hanya 3/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Harga satuan"));
    await user.type(screen.getByLabelText("Harga satuan"), "60000");
    expect(screen.getByText("Harga produk Rp 65.000")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Nama pembeli"), "Dewi Anggraini");
    await user.type(screen.getByLabelText("Telepon pembeli"), "081234567801");
    await user.type(screen.getByLabelText("Alamat"), "Jl. Melati No. 5");
    await user.type(screen.getByLabelText("Ongkir"), "12000");
    expect(screen.getByText("Rp 252.000")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Buat pesanan" }));
    await waitFor(() => expect(testRouter.push).toHaveBeenCalledWith(`/pesanan?id=${ORDER.id}`));
    const post = calls.filter((c) => c.method === "POST");
    expect(post).toHaveLength(1);
    expect(post[0]?.headers?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(post[0]?.body).toEqual({
      buyer: { name: "Dewi Anggraini", phone: "081234567801" },
      shippingAddress: { line1: "Jl. Melati No. 5" },
      items: [{ variantId: PRODUCT.variants[0]?.id, qty: 4, unitPrice: 60_000 }],
      shippingFee: 12_000,
      discount: 0,
      paymentMethod: "transfer",
      paid: false,
    });
    expect(await screen.findByText("Pesanan MN-2610-0001 dibuat.")).toBeInTheDocument();
  });

  it("says what is missing before sending anything", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<ManualOrderForm />);
    await user.click(screen.getByRole("button", { name: "Buat pesanan" }));
    expect(screen.getByText("Tambahkan paling sedikit satu barang.")).toBeInTheDocument();
    expect(screen.getByLabelText("Nama pembeli")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Alamat")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Isi telepon penerima atau telepon pembeli/)).toBeInTheDocument();
    expect(screen.getByText("Periksa isian yang ditandai merah.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("records a cash sale picked up at the counter, from a scanned barcode", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<ManualOrderForm />);

    await user.type(screen.getByLabelText("Tambah barang"), "0000{Enter}");
    expect(await screen.findByText("Tidak ada produk dengan barcode atau SKU 0000.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Tambah barang"));
    await user.type(screen.getByLabelText("Tambah barang"), "8991234567890{Enter}");
    expect(await screen.findByText("KAOS-HTM")).toBeInTheDocument();

    await user.click(screen.getByText("Diambil pembeli atau di tempat"));
    expect(screen.queryByLabelText("Alamat")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Tunai"));
    expect(screen.getByRole("switch", { name: "Sudah dibayar" })).toBeChecked();
    await user.type(screen.getByLabelText("Nama pembeli"), "Pembeli toko");
    await user.click(screen.getByRole("button", { name: "Buat pesanan" }));

    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      shippingAddress: null,
      shippingFee: 0,
      paymentMethod: "cash",
      paid: true,
      items: [{ variantId: PRODUCT.variants[0]?.id, qty: 1, unitPrice: 65_000 }],
    });
  });

  it("puts the api's field errors under their fields and retries with the same key", async () => {
    let first = true;
    const calls = api(() => {
      if (first) {
        first = false;
        return problem(422, "validation.failed", "Periksa isian.", {
          errors: [{ path: "buyer.phone", message: "Nomor telepon tidak dikenal." }],
        });
      }
      return ORDER;
    });
    const user = userEvent.setup();
    renderApp(<ManualOrderForm />);
    await addShirt(user);
    await user.type(screen.getByLabelText("Nama pembeli"), "Dewi");
    await user.type(screen.getByLabelText("Telepon pembeli"), "081234567801");
    await user.click(screen.getByText("Diambil pembeli atau di tempat"));
    await user.click(screen.getByRole("button", { name: "Buat pesanan" }));
    expect(await screen.findByText("Nomor telepon tidak dikenal.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Buat pesanan" }));
    await waitFor(() => expect(testRouter.push).toHaveBeenCalled());
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.headers?.["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("COD needs no paid switch", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<ManualOrderForm />);
    await addShirt(user);
    await user.type(screen.getByLabelText("Nama pembeli"), "Dewi");
    await user.type(screen.getByLabelText("Telepon pembeli"), "081234567801");
    await user.type(screen.getByLabelText("Alamat"), "Jl. Melati No. 5");
    await user.click(screen.getByLabelText("COD"));
    expect(screen.queryByRole("switch", { name: "Sudah dibayar" })).not.toBeInTheDocument();
    expect(screen.getByText(/COD dibayar saat barang diterima/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Buat pesanan" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")?.body).not.toHaveProperty("paid");
  });

  it("is closed to users who may not change orders", () => {
    api();
    renderApp(<ManualOrderForm />, { me: testMe(["order:read"]) });
    expect(
      screen.getByText("Hanya pengguna yang boleh mengubah pesanan yang bisa membuat pesanan manual."),
    ).toBeInTheDocument();
  });
});
