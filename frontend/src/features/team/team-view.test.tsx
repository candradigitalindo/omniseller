import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { mockApi, renderApp, testMe } from "@/test/render";
import { TeamView } from "./team-view";

const ME = "01JUSER0000000000000000000";
const BUDI = "01JUSER0000000000000000002";
const OWNER_ROLE = {
  id: "R-OWNER",
  name: "Pemilik",
  isSystem: true,
  description: "Semua izin",
  permissions: ["order:read", "settings:billing"],
};
const WAREHOUSE_ROLE = {
  id: "R-GUDANG",
  name: "Gudang",
  isSystem: true,
  description: "Kemas dan kirim",
  permissions: ["order:read", "shipment:pack"],
};

function api() {
  return mockApi({
    "GET /v1/users": () => ({
      items: [
        {
          id: ME,
          name: "Rina Wulandari",
          email: "rina@example.test",
          status: "active",
          roles: [{ id: "R-OWNER", name: "Pemilik" }],
          storeIds: null,
          warehouseIds: null,
          lastLoginAt: "2026-10-06T00:00:00.000Z",
          twoFactorEnabled: false,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        {
          id: BUDI,
          name: "Budi Santoso",
          email: "budi@example.test",
          status: "active",
          roles: [{ id: "R-GUDANG", name: "Gudang" }],
          storeIds: ["S1"],
          warehouseIds: null,
          lastLoginAt: null,
          twoFactorEnabled: true,
          createdAt: "2026-09-02T00:00:00.000Z",
        },
        {
          id: "01JUSER0000000000000000003",
          name: "Sari Dewi",
          email: "sari.dewi@example.test",
          status: "active",
          roles: [{ id: "R-GUDANG", name: "Gudang" }],
          storeIds: null,
          warehouseIds: null,
          lastLoginAt: "2026-10-05T00:00:00.000Z",
          twoFactorEnabled: false,
          createdAt: "2026-09-03T00:00:00.000Z",
        },
      ],
      next_cursor: null,
    }),
    "GET /v1/stores": () => ({
      items: [
        { id: "S1", name: "Toko Rina Shopee", channel: "shopee", status: "active", syncMode: "live" },
        { id: "S2", name: "Toko Rina TTS", channel: "tiktokshop", status: "active", syncMode: "live" },
      ],
    }),
    "GET /v1/warehouses": () => ({
      items: [
        { id: "W1", name: "Gudang Jakarta" },
        { id: "W2", name: "Gudang Surabaya" },
      ],
    }),
    "GET /v1/roles": () => ({ items: [OWNER_ROLE, WAREHOUSE_ROLE], next_cursor: null }),
    "GET /v1/permissions": () => ({
      items: [
        { code: "order:read", module: "Pesanan", description: "Lihat pesanan" },
        { code: "shipment:pack", module: "Pengiriman", description: "Kemas pesanan" },
      ],
      next_cursor: null,
    }),
    [`PATCH /v1/users/${BUDI}`]: (c) => ({
      id: BUDI,
      name: "Budi Santoso",
      status: (c.body as { status: string }).status,
    }),
    [`PUT /v1/users/${BUDI}/roles`]: () => ({ id: BUDI }),
    [`POST /v1/users/${BUDI}/sessions/revoke`]: () => ({ revoked: 2 }),
    [`POST /v1/users/${BUDI}/two-factor/reset`]: () => ({ id: BUDI, name: "Budi Santoso", twoFactorEnabled: false }),
    [`PUT /v1/users/${BUDI}/scopes`]: () => ({ id: BUDI }),
    "GET /v1/invitations": () => ({
      items: [
        {
          id: "I1",
          email: "sari@example.test",
          roleId: "R-GUDANG",
          roleName: "Gudang",
          status: "sent",
          expiresAt: "2026-10-09T00:00:00.000Z",
          sentAt: "2026-10-06T00:00:00.000Z",
          createdAt: "2026-10-06T00:00:00.000Z",
        },
      ],
      next_cursor: null,
    }),
    "POST /v1/invitations": (c) => ({
      id: "I2",
      email: (c.body as { email: string }).email,
      roleId: "R-GUDANG",
      roleName: "Gudang",
      status: "pending",
      expiresAt: "2026-10-09T00:00:00.000Z",
      sentAt: null,
      createdAt: "2026-10-06T00:00:00.000Z",
    }),
    "POST /v1/invitations/I1/resend": () => ({ id: "I1", email: "sari@example.test" }),
    "DELETE /v1/invitations/I1": () => undefined,
  });
}

async function openActions(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click((await screen.findAllByRole("button", { name: `Aksi untuk ${name}` }))[0]!);
}

describe("TeamView (L41)", () => {
  beforeEach(() => setUrl("/tim"));

  it("lists members with roles and scope, and cannot disable oneself", async () => {
    api();
    const user = userEvent.setup();
    renderApp(<TeamView />);
    expect((await screen.findAllByText("Budi Santoso")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Toko Rina Shopee").length).toBeGreaterThan(0);
    expect(screen.getAllByText("(Anda)").length).toBeGreaterThan(0);
    await openActions(user, "Rina Wulandari");
    expect(screen.queryByRole("menuitem", { name: "Nonaktifkan" })).not.toBeInTheDocument();
  });

  it("signs a member out of every device and turns off a two-step login they lost, after asking", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<TeamView />);
    expect((await screen.findAllByText("2FA aktif")).length).toBeGreaterThan(0);

    await openActions(user, "Budi Santoso");
    await user.click(await screen.findByRole("menuitem", { name: "Keluarkan dari semua perangkat" }));
    const ask = await screen.findByRole("dialog", { name: "Keluarkan Budi Santoso dari semua perangkat?" });
    await user.click(within(ask).getByRole("button", { name: "Keluarkan" }));
    expect(await screen.findByText("Budi Santoso dikeluarkan dari 2 perangkat.")).toBeInTheDocument();

    await openActions(user, "Budi Santoso");
    await user.click(await screen.findByRole("menuitem", { name: "Matikan verifikasi dua langkah" }));
    const reset = await screen.findByRole("dialog", { name: "Matikan verifikasi dua langkah Budi Santoso?" });
    expect(reset).toHaveTextContent("kehilangan ponsel dan kode cadangannya");
    await user.click(within(reset).getByRole("button", { name: "Matikan" }));
    expect(await screen.findByText("Verifikasi dua langkah Budi Santoso dimatikan.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      `/v1/users/${BUDI}/sessions/revoke`,
      `/v1/users/${BUDI}/two-factor/reset`,
    ]);
  });

  it("offers neither action for oneself, nor turning off a two-step login that is off", async () => {
    api();
    const user = userEvent.setup();
    renderApp(<TeamView />);
    await openActions(user, "Rina Wulandari");
    await screen.findByRole("menuitem", { name: "Ubah peran" });
    expect(screen.queryByRole("menuitem", { name: "Keluarkan dari semua perangkat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Matikan verifikasi dua langkah" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    // a member without two-step verification can be signed out, but has nothing to turn off
    await openActions(user, "Sari Dewi");
    expect(await screen.findByRole("menuitem", { name: "Keluarkan dari semua perangkat" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Matikan verifikasi dua langkah" })).not.toBeInTheDocument();
  });

  it("disables another member", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<TeamView />);
    await openActions(user, "Budi Santoso");
    await user.click(await screen.findByRole("menuitem", { name: "Nonaktifkan" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "disabled" }));
    expect(await screen.findByText(/Budi Santoso dinonaktifkan/)).toBeInTheDocument();
  });

  it("gives only roles the user may give", async () => {
    const calls = api();
    const user = userEvent.setup();
    // this admin lacks settings:billing, so the owner role is not theirs to give
    renderApp(<TeamView />, { me: testMe(["settings:user", "order:read", "shipment:pack"]) });
    await openActions(user, "Budi Santoso");
    await user.click(await screen.findByRole("menuitem", { name: "Ubah peran" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("checkbox", { name: /Pemilik/ })).toBeDisabled();
    expect(within(dialog).getByText("Butuh izin yang tidak Anda miliki.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT" && c.path.endsWith("/roles"))?.body).toEqual({
        roleIds: ["R-GUDANG"],
      }),
    );
  });

  it("limits a member to chosen stores, never to an empty list", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<TeamView />);
    await openActions(user, "Budi Santoso");
    await user.click(await screen.findByRole("menuitem", { name: "Atur toko dan gudang" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: "Toko Rina Shopee" }));
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Pilih paling sedikit satu toko");
    await user.click(within(dialog).getByRole("checkbox", { name: "Toko Rina TTS" }));
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/scopes"))?.body).toEqual({ storeIds: ["S2"], warehouseIds: null }),
    );
  });

  it("invites by email with a role, then shows the invitations", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<TeamView />);
    await user.click(screen.getByRole("button", { name: "Undang anggota" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Email"), "sari@");
    await user.click(within(dialog).getByRole("button", { name: "Kirim undangan" }));
    expect(within(dialog).getByText("Email tidak valid.")).toBeInTheDocument();
    expect(within(dialog).getByText("Pilih peran", { selector: "p" })).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Email"), "example.test");
    await user.click(within(dialog).getByRole("combobox", { name: "Peran" }));
    await user.click(await screen.findByRole("option", { name: "Gudang" }));
    await user.click(within(dialog).getByRole("button", { name: "Kirim undangan" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.path === "/v1/invitations")?.body).toEqual({
        email: "sari@example.test",
        roleId: "R-GUDANG",
      }),
    );
    expect(currentUrl()).toBe("/tim?tab=undangan");
  });

  it("resends and cancels invitations", async () => {
    setUrl("/tim?tab=undangan");
    const calls = api();
    const user = userEvent.setup();
    renderApp(<TeamView />);
    await user.click(await screen.findByRole("button", { name: "Kirim ulang" }));
    expect(await screen.findByText(/Tautan lama tidak berlaku lagi/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Batalkan" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("shows which role holds which permission", async () => {
    setUrl("/tim?tab=peran");
    api();
    renderApp(<TeamView />);
    const row = (await screen.findByText("Kemas pesanan")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Gudang: ya")).toBeInTheDocument();
    expect(within(row).getByText("Pemilik: tidak")).toBeInTheDocument();
  });

  it("is closed to users who may not manage the team", () => {
    api();
    renderApp(<TeamView />, { me: testMe(["order:read"]) });
    expect(screen.getByText("Halaman ini hanya bisa dibuka pengguna yang boleh mengelola tim.")).toBeInTheDocument();
  });
});
