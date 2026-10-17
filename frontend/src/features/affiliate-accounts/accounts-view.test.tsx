import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { components } from "@/lib/api/schema";
import { mockApi, renderApp, testMe } from "@/test/render";
import { AffiliateAccountsView } from "./accounts-view";

const leave = vi.hoisted(() => vi.fn());
vi.mock("@/lib/navigate", () => ({ leaveTo: leave }));
type Account = components["schemas"]["AffiliateAccountDto_Output"];
const base: Account = {
  id: "01JACCOUNT00000000000000001",
  channel: "tiktokshop",
  program: "standard",
  regionVerified: true,
  kind: "affiliate_partner",
  name: "Mitra Candra",
  externalPrincipalId: "partner-id",
  region: "ID",
  status: "active",
  scopes: ["partner.authorization.info"],
  profile: { categories: [{ id: "123", name: "Kategori uji", market: "ID" }] },
  connectedAt: "2026-10-17T00:00:00Z",
  disconnectedAt: null,
  accessExpiresAt: "2026-10-24T00:00:00Z",
  authorizationExpiresAt: "2027-10-17T00:00:00Z",
  errorCode: null,
  errorMessage: null,
  rowVersion: 1,
};
const detailPath = `/v1/affiliate/accounts/${base.id}`;
function setup() {
  let current = base;
  return mockApi({
    "GET /v1/affiliate/accounts": (call) => ({
      items: call.query.cursor ? [{ ...current, id: "01JACCOUNT00000000000000002", name: "Creator kedua" }] : [current],
      next_cursor: call.query.cursor ? null : "next-cursor",
    }),
    [`GET ${detailPath}`]: () => current,
    [`PATCH ${detailPath}`]: (call) => {
      current = { ...current, name: (call.body as { name: string }).name, rowVersion: 2 };
      return current;
    },
    [`POST ${detailPath}/refresh`]: () => undefined,
    [`POST ${detailPath}/disconnect`]: () => {
      current = { ...current, status: "disconnected" };
      return undefined;
    },
    "POST /v1/affiliate/authorizations": () => ({
      id: "01JAUTH0000000000000000001",
      authorizeUrl: "https://partner.tiktokshop.com/open/authorize?state=a1_fixture",
    }),
  });
}
const permissions = ["affiliate:account_read", "affiliate:account_write"] as const;
describe("creator and partner account management", () => {
  it("uses searchable account selection and opens the returned official authorization URL", async () => {
    leave.mockClear();
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<AffiliateAccountsView />, { me: testMe([...permissions]) });
    await user.click(screen.getByRole("button", { name: "Hubungkan akun" }));
    const dialog = screen.getByRole("dialog", { name: "Hubungkan akun Indonesia" });
    await user.click(within(dialog).getByRole("combobox", { name: "Jenis akun" }));
    await user.type(screen.getByRole("searchbox", { name: "Cari pilihan…" }), "partner");
    await user.click(screen.getByRole("option", { name: "Affiliate Partner Indonesia" }));
    await user.click(within(dialog).getByRole("button", { name: "Lanjutkan otorisasi" }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith(expect.stringContaining("https://partner.tiktokshop.com/")));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      channel: "tiktokshop",
      program: "standard",
      kind: "affiliate_partner",
    });
  });
  it("connects a separate Shopee LIVE creator and explains that account country is unverified", async () => {
    leave.mockClear();
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<AffiliateAccountsView />, { me: testMe([...permissions]) });
    await user.click(screen.getByRole("button", { name: "Hubungkan akun" }));
    const dialog = screen.getByRole("dialog", { name: "Hubungkan akun Indonesia" });
    await user.click(within(dialog).getByRole("combobox", { name: "Marketplace" }));
    await user.type(screen.getByRole("searchbox", { name: "Cari pilihan…" }), "Shopee");
    await user.click(screen.getByRole("option", { name: "Shopee" }));
    expect(within(dialog).queryByRole("combobox", { name: "Jenis akun" })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Shopee tidak mengirim wilayah akun/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("combobox", { name: "Program creator" }));
    await user.type(screen.getByRole("searchbox", { name: "Cari pilihan…" }), "live");
    await user.click(screen.getByRole("option", { name: "Shopee LIVE" }));
    await user.click(within(dialog).getByRole("button", { name: "Lanjutkan otorisasi" }));
    await waitFor(() => expect(leave).toHaveBeenCalled());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      channel: "shopee",
      program: "live",
      kind: "creator",
    });
  });

  it("displays Shopee target country without claiming provider verification", async () => {
    const shopee = { ...base, channel: "shopee", program: "video", kind: "creator", regionVerified: false, scopes: [] };
    mockApi({
      "GET /v1/affiliate/accounts": () => ({ items: [shopee], next_cursor: null }),
      [`GET ${detailPath}`]: () => shopee,
    });
    const user = userEvent.setup();
    renderApp(<AffiliateAccountsView />, { me: testMe([...permissions]) });
    await user.click(await screen.findByRole("button", { name: "Detail Mitra Candra" }));
    const dialog = screen.getByRole("dialog", { name: "Detail akun" });
    expect(within(dialog).getByText("Indonesia · wilayah akun belum terverifikasi")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("tab", { name: "Izin" }));
    expect(within(dialog).getByText(/Shopee tidak mengembalikan daftar scope/)).toBeInTheDocument();
  });

  it("shows only public category metadata, saves with optimistic locking, queues refresh and requires disconnect confirmation", async () => {
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<AffiliateAccountsView />, { me: testMe([...permissions]) });
    await user.click(await screen.findByRole("button", { name: "Detail Mitra Candra" }));
    const dialog = screen.getByRole("dialog", { name: "Detail akun" });
    await user.click(within(dialog).getByRole("tab", { name: "Kategori" }));
    expect(within(dialog).getByText("Kategori uji")).toBeInTheDocument();
    expect(within(dialog).getByText("123")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("tab", { name: "Kelola" }));
    await user.clear(screen.getByLabelText("Nama di OmniSeller"));
    await user.type(screen.getByLabelText("Nama di OmniSeller"), "Nama baru");
    await user.click(within(dialog).getByRole("button", { name: "Simpan nama" }));
    await screen.findByText("Nama akun diperbarui.");
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
      body: { name: "Nama baru" },
      headers: { "if-match": "1" },
    });
    await user.click(within(dialog).getByRole("button", { name: "Perbarui profil" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/refresh"))?.headers?.["idempotency-key"]).toBeTruthy(),
    );
    await user.click(within(dialog).getByRole("button", { name: "Putuskan koneksi" }));
    expect(calls.filter((c) => c.path.endsWith("/disconnect"))).toHaveLength(0);
    const confirm = screen.getByRole("dialog", { name: "Putuskan akun ini?" });
    await user.click(within(confirm).getByRole("button", { name: "Putuskan koneksi" }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/disconnect"))).toHaveLength(1));
  });
  it("paginates and searches accounts, and hides changes from a read-only role", async () => {
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<AffiliateAccountsView />, { me: testMe(["affiliate:account_read"]) });
    expect(screen.queryByRole("button", { name: "Hubungkan akun" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Berikutnya" }));
    await screen.findByText("Creator kedua");
    await user.type(screen.getByRole("textbox", { name: "Cari nama atau ID akun" }), "Candra");
    await user.click(screen.getByRole("button", { name: "Cari akun" }));
    await screen.findByText("Mitra Candra");
    expect(calls.filter((c) => c.path === "/v1/affiliate/accounts").at(-1)?.query).toMatchObject({ q: "Candra" });
    await user.click(screen.getByRole("button", { name: "Detail Mitra Candra" }));
    await user.click(screen.getByRole("tab", { name: "Kelola" }));
    expect(screen.queryByRole("button", { name: "Simpan nama" })).not.toBeInTheDocument();
  });
  it("never fetches account data without the dedicated permission", () => {
    const calls = setup();
    renderApp(<AffiliateAccountsView />, { me: testMe(["affiliate:read"]) });
    expect(screen.getByText("Anda belum memiliki izin membaca akun creator dan partner.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
