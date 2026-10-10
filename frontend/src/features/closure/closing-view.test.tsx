import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ALL_PERMISSIONS, mockApi, renderApp, testMe } from "@/test/render";
import { ClosingView } from "./closing-view";

const leaveTo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/navigate", () => ({ leaveTo }));

const DAY = 86_400_000;
const closing = (permissions = ALL_PERMISSIONS) => {
  const me = testMe(permissions);
  return { ...me, tenant: { ...me.tenant, status: "closing" as const } };
};
const CLOSURE = {
  status: "closing",
  closingAt: "2026-10-10T03:00:00.000Z",
  // a little more than 29 days ahead: 30 days left, counted up
  purgeAfter: new Date(Date.now() + 29 * DAY + 3_600_000).toISOString(),
  closedBy: { id: "01JUSER0000000000000000001", name: "Rina Wulandari" },
  revokeLinks: [{ channel: "shopee", url: "https://partner.shopeemobile.com/api/v2/shop/cancel_auth_partner?x=1" }],
  purgeAfterDays: 30,
};

describe("ClosingView (L54)", () => {
  it("says when the data goes, who closed it, what stopped, and where to withdraw the app", async () => {
    mockApi({ "GET /v1/account-closure": () => CLOSURE, "GET /v1/exports": () => ({ items: [] }) });
    renderApp(<ClosingView />, { me: closing() });
    expect(await screen.findByRole("heading", { level: 1, name: "Akun Toko Rina sedang ditutup" })).toBeInTheDocument();
    expect(screen.getByText(/Seluruh data bisnis akan dihapus pada .+ \(30 hari lagi\)\./)).toBeInTheDocument();
    expect(screen.getByText(/Ditutup oleh Rina Wulandari pada 10 Okt 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Anggota tim tidak bisa masuk/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cabut di Shopee" })).toHaveAttribute("href", CLOSURE.revokeLinks[0]!.url);
    // the data export, as a section of this page
    expect(await screen.findByRole("heading", { level: 2, name: "Ekspor Data" })).toBeInTheDocument();
    expect(screen.getByText(/Unduh sebelum .+: setelah itu ekspor ikut terhapus\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buat ekspor" })).toBeInTheDocument();
  });

  it("reopens after asking, and signs out", async () => {
    const calls = mockApi({
      "GET /v1/account-closure": () => CLOSURE,
      "GET /v1/exports": () => ({ items: [] }),
      "DELETE /v1/account-closure": () => ({ ...CLOSURE, status: "active", closingAt: null, purgeAfter: null }),
      "POST /v1/auth/logout": () => undefined,
    });
    const user = userEvent.setup();
    renderApp(<ClosingView />, { me: closing() });
    await user.click(await screen.findByRole("button", { name: "Buka kembali akun" }));
    const dialog = screen.getByRole("dialog", { name: "Buka kembali akun Toko Rina?" });
    expect(within(dialog).getByText(/Toko marketplace tetap terputus/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Buka kembali" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText("Akun dibuka kembali.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keluar" }));
    await waitFor(() => expect(leaveTo).toHaveBeenCalledWith("/masuk"));
    expect(calls.some((c) => c.method === "POST" && c.path === "/v1/auth/logout")).toBe(true);
  });

  it("leaves the export out for who may not take it", async () => {
    const calls = mockApi({ "GET /v1/account-closure": () => ({ ...CLOSURE, revokeLinks: [] }) });
    renderApp(<ClosingView />, { me: closing(ALL_PERMISSIONS.filter((p) => p !== "data:export")) });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("heading", { name: "Ekspor Data" })).toBeNull();
    expect(screen.queryByText("Cabut juga izin OmniSeller di marketplace")).toBeNull();
    expect(calls.some((c) => c.path === "/v1/exports")).toBe(false);
  });
});
