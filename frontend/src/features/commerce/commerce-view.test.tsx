import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, renderApp, testMe } from "@/test/render";
import { CommerceView, hasOperationScopes } from "./commerce-view";
import type { CommerceOperation, CommercePrincipal, CommerceRequest } from "./contracts";

const principal: CommercePrincipal = {
  id: "01JACCOUNT00000000000000001",
  kind: "creator",
  channel: "tiktokshop",
  name: "Candra Creator",
  status: "active",
  scopes: ["creator.showcase.read", "creator.showcase.write"],
  region: "ID",
  readOnly: false,
  categories: [],
  sellerType: "unknown",
};
const read: CommerceOperation = {
  id: "tiktokshop.creator.showcase.list",
  channel: "tiktokshop",
  principalKind: "creator",
  group: "Showcase creator",
  title: "Daftar etalase",
  method: "GET",
  path: "/affiliate_creator/202405/showcases/products",
  scopes: ["creator.showcase.read"],
  write: false,
  officialUrl: "https://partner.tiktokshop.com/docv2/page/get-showcase-products",
  available: true,
  unavailableReason: null,
  requiredPermissions: [],
  fields: [
    { name: "query.page_size", label: "Jumlah produk", type: "integer", required: true, minimum: 1, maximum: 100 },
    { name: "query.page_token", label: "Halaman lanjutan", type: "string", required: false },
  ],
};
const write: CommerceOperation = {
  ...read,
  id: "tiktokshop.creator.showcase.add",
  title: "Tambah produk etalase",
  method: "POST",
  write: true,
  scopes: ["creator.showcase.write"],
  fields: [
    {
      name: "body.product_ids",
      label: "Produk",
      type: "array",
      required: true,
      itemType: "string",
      minimum: 1,
      maximum: 20,
    },
  ],
};
const request: CommerceRequest = {
  id: "01JREQUEST0000000000000001",
  operationId: read.id,
  principalId: principal.id,
  principalKind: "creator",
  status: "succeeded",
  result: {
    data: { products: [{ id: "9007199254740993", title: "Produk Candra" }] },
    nextCursor: null,
    acknowledgement: "read",
  },
  nextCursor: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-10-17T01:00:00Z",
  finishedAt: "2026-10-17T01:00:01Z",
  expiresAt: "2026-10-18T01:00:00Z",
};
function setup(operations: CommerceOperation[] = [read, write], account = principal) {
  let current = request;
  return mockApi({
    "GET /v1/commerce/operations": () => ({ items: operations }),
    "GET /v1/commerce/principals": () => ({ items: [account] }),
    "POST /v1/commerce/requests": (call) => {
      current = {
        ...request,
        operationId: (call.body as { operationId: string }).operationId,
        result: {
          ...request.result!,
          acknowledgement: (call.body as { operationId: string }).operationId === write.id ? "accepted" : "read",
        },
      };
      return current;
    },
    [`GET /v1/commerce/requests/${request.id}`]: () => current,
    "GET /v1/commerce/requests": (call) => ({
      items: [{ ...request, id: call.query.cursor ? "request-next" : request.id }],
      nextCursor: call.query.cursor ? null : "next-cursor",
    }),
  });
}
const permissions = ["commerce:read", "commerce:write"] as const;

describe("commerce operations workspace", () => {
  it("reads a verified operation with typed official fields and persists one idempotency key", async () => {
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<CommerceView />, { me: testMe([...permissions]) });
    await user.click(await screen.findByRole("button", { name: "Buka: Daftar etalase" }));
    const dialog = screen.getByRole("dialog", { name: "Daftar etalase" });
    await user.type(within(dialog).getByLabelText(/Jumlah produk/), "20");
    await user.click(within(dialog).getByRole("button", { name: "Berikutnya" }));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Ambil data" }));
    await screen.findByRole("dialog", { name: "Hasil permintaan" });
    const posted = calls.find((call) => call.method === "POST");
    expect(posted?.body).toEqual({
      operationId: read.id,
      principalId: principal.id,
      input: { query: { page_size: 20 } },
      confirmed: false,
    });
    expect(posted?.headers?.["idempotency-key"]).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Lihat 1 item" }));
    await user.click(screen.getByRole("button", { name: "Lihat rincian" }));
    expect(screen.getByText("Produk Candra")).toBeInTheDocument();
    expect(screen.getByText("9007199254740993")).toBeInTheDocument();
  });
  it("builds structured product arrays and requires explicit approval before a marketplace write", async () => {
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<CommerceView />, { me: testMe([...permissions]) });
    await user.click(await screen.findByRole("button", { name: "Buka: Tambah produk etalase" }));
    const dialog = screen.getByRole("dialog", { name: "Tambah produk etalase" });
    await user.click(within(dialog).getByRole("button", { name: "Produk" }));
    const items = screen.getByRole("dialog", { name: "Produk" });
    await user.click(within(items).getByRole("button", { name: "Tambah item" }));
    await user.type(within(items).getByLabelText(/Nilai item/), "9007199254740993");
    await user.click(within(items).getByRole("button", { name: "Simpan rincian" }));
    await user.click(within(dialog).getByRole("button", { name: "Berikutnya" }));
    expect(within(dialog).getByRole("button", { name: "Setujui & kirim" })).toBeDisabled();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Saya menyetujui perubahan pada akun Candra Creator." }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Setujui & kirim" }));
    await screen.findByRole("dialog", { name: "Hasil permintaan" });
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      operationId: write.id,
      principalId: principal.id,
      input: { body: { product_ids: ["9007199254740993"] } },
      confirmed: true,
    });
    expect(screen.getByText("Diterima marketplace")).toBeInTheDocument();
  });
  it("explains missing marketplace scopes and custom role write restrictions before showing a form", async () => {
    const calls = setup([write]);
    const user = userEvent.setup();
    renderApp(<CommerceView />, { me: testMe(["commerce:read"]) });
    await user.click(await screen.findByRole("button", { name: "Persyaratan: Tambah produk etalase" }));
    expect(screen.getByText("Peran Anda belum memiliki izin mengubah data commerce.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Setujui & kirim" })).not.toBeInTheDocument();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("explains missing platform scope independently of tenant permissions", async () => {
    const calls = setup([write], { ...principal, scopes: [] });
    const user = userEvent.setup();
    renderApp(<CommerceView />, { me: testMe([...permissions]) });
    await user.click(await screen.findByRole("button", { name: "Persyaratan: Tambah produk etalase" }));
    expect(screen.getByText("Akun ini belum memberikan izin marketplace yang diperlukan.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Setujui & kirim" })).not.toBeInTheDocument();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("keeps read-only seller stores from offering writes", async () => {
    setup([write], { ...principal, readOnly: true });
    const user = userEvent.setup();
    renderApp(<CommerceView />, { me: testMe([...permissions]) });
    await user.click(await screen.findByRole("button", { name: "Persyaratan: Tambah produk etalase" }));
    expect(
      screen.getByText(
        "Toko ini dalam mode baca saja. Aktifkan sinkronisasi melalui Toko Terhubung sebelum mengubah data.",
      ),
    ).toBeInTheDocument();
  });
  it("selects public partner category IDs without requesting private category ciphers", async () => {
    const operation: CommerceOperation = {
      ...read,
      principalKind: "affiliate_partner",
      categoryAsset: true,
      scopes: [],
      fields: [],
    };
    const partner: CommercePrincipal = {
      ...principal,
      kind: "affiliate_partner",
      categories: [
        { id: 101, name: "Kategori pertama" },
        { id: 202, name: "Kategori kedua" },
      ],
    };
    const calls = setup([operation], partner);
    const user = userEvent.setup();
    renderApp(<CommerceView />, { me: testMe([...permissions]) });
    await user.click(await screen.findByRole("button", { name: "Buka: Daftar etalase" }));
    const dialog = screen.getByRole("dialog", { name: "Daftar etalase" });
    await user.click(within(dialog).getByRole("combobox", { name: "Kategori aset partner" }));
    await user.type(screen.getByRole("searchbox", { name: "Cari pilihan…" }), "kedua");
    await user.click(screen.getByRole("option", { name: "Kategori kedua" }));
    await user.click(within(dialog).getByRole("button", { name: "Berikutnya" }));
    await user.click(within(dialog).getByRole("button", { name: "Ambil data" }));
    await screen.findByRole("dialog", { name: "Hasil permintaan" });
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ input: { categoryAssetId: 202 } });
    expect(JSON.stringify(calls.find((call) => call.method === "POST")?.body)).not.toContain("cipher");
  });
  it("requires the operation's domain permission in addition to generic commerce write", async () => {
    const calls = setup([{ ...write, requiredPermissions: ["commerce:read", "commerce:write", "affiliate:write"] }]);
    const user = userEvent.setup();
    renderApp(<CommerceView />, { me: testMe([...permissions]) });
    await user.click(await screen.findByRole("button", { name: "Persyaratan: Tambah produk etalase" }));
    expect(
      screen.getByText(
        "Peran Anda belum memiliki izin untuk fitur ini. Minta pengelola bisnis memberikan akses yang sesuai.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Setujui & kirim" })).not.toBeInTheDocument();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("keeps local sellers from starting an operation restricted to cross-border accounts", async () => {
    setup([{ ...write, principalKind: "seller", accountRequirements: ["cross_border"] }], {
      ...principal,
      kind: "seller",
      sellerType: "local",
    });
    const user = userEvent.setup();
    renderApp(<CommerceView />, { me: testMe([...permissions]) });
    await user.click(await screen.findByRole("button", { name: "Persyaratan: Tambah produk etalase" }));
    expect(
      screen.getByText(
        "Fitur ini memerlukan jenis toko lokal atau lintas negara yang berbeda. Periksa jenis penjual dan kelayakan program toko di marketplace.",
      ),
    ).toBeInTheDocument();
  });
  it("shows Indonesian enum labels while sending the exact documented wire value", async () => {
    const calls = setup([
      {
        ...read,
        fields: [
          { name: "query.status", label: "Status", type: "enum", required: true, options: ["ACTIVE", "INACTIVE"] },
        ],
      },
    ]);
    const user = userEvent.setup();
    renderApp(<CommerceView />, { me: testMe([...permissions]) });
    await user.click(await screen.findByRole("button", { name: "Buka: Daftar etalase" }));
    const dialog = screen.getByRole("dialog", { name: "Daftar etalase" });
    await user.click(within(dialog).getByRole("combobox", { name: "Status" }));
    await user.type(screen.getByRole("searchbox", { name: "Cari pilihan…" }), "aktif");
    await user.click(screen.getByRole("option", { name: "Aktif" }));
    await user.click(within(dialog).getByRole("button", { name: "Berikutnya" }));
    await user.click(within(dialog).getByRole("button", { name: "Ambil data" }));
    await screen.findByRole("dialog", { name: "Hasil permintaan" });
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      input: { query: { status: "ACTIVE" } },
    });
  });
  it("supports searchable account/category choices and opaque request history pagination", async () => {
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<CommerceView />, { me: testMe([...permissions]) });
    await screen.findByRole("button", { name: "Buka: Daftar etalase" });
    await user.click(screen.getByRole("combobox", { name: "Akun marketplace" }));
    await user.type(screen.getByRole("searchbox", { name: "Cari pilihan…" }), "Candra");
    expect(screen.getByRole("option", { name: "Candra Creator · TikTok Shop · Creator" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Riwayat" }));
    const history = screen.getByRole("dialog", { name: "Riwayat permintaan" });
    await user.click(await within(history).findByRole("button", { name: "Berikutnya" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.path === "/v1/commerce/requests").at(-1)?.query.cursor).toBe("next-cursor"),
    );
  });
  it("makes no commerce calls without the dedicated permission", () => {
    const calls = setup();
    renderApp(<CommerceView />, { me: testMe(["affiliate:account_read"]) });
    expect(screen.getByText("Anda belum memiliki izin mengakses fitur commerce.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it("honors documented any-of scopes without treating an empty any-of list as granted", () => {
    expect(hasOperationScopes({ scopes: ["creator.showcase.read", "missing"], scopeMode: "any" }, principal)).toBe(
      true,
    );
    expect(hasOperationScopes({ scopes: ["creator.showcase.read", "missing"], scopeMode: "all" }, principal)).toBe(
      false,
    );
    expect(hasOperationScopes({ scopes: [], scopeMode: "any" }, principal)).toBe(false);
  });
});
