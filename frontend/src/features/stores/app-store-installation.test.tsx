import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/navigation";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import { AppStoreInstallation } from "./app-store-installation";
import type { Authorization } from "./store-meta";

const challenge = { confirmationToken: "x".repeat(43), expiresAt: "2026-10-18T00:10:00.000Z" };
const authorization: Authorization = {
  id: "01JAUTH0000000000000000001",
  channel: "tiktokshop",
  storeId: null,
  status: "exchanging",
  expiresAt: challenge.expiresAt,
  callbackAt: "2026-10-18T00:00:00.000Z",
  completedAt: null,
  result: { stores: [], skipped: [], failed: [] },
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-10-18T00:00:00.000Z",
};

beforeEach(() => setUrl("/integrasi/instalasi/tiktokshop"));

describe("App Store installation confirmation", () => {
  it("shows the active business and unverified identity before requiring explicit consent", async () => {
    const user = userEvent.setup();
    let selected = false;
    const installation = {
      awaitingShopSelection: true,
      shops: [{ externalShopId: "777001", name: "Toko Terverifikasi", region: "ID" }],
      selectedShopIds: [],
    };
    const calls = mockApi({
      "GET /v1/store-installations/tiktokshop": () => challenge,
      "POST /v1/store-installations/tiktokshop/confirm": () => authorization,
      "POST /v1/store-installations/tiktokshop/select-shops": () => {
        selected = true;
        return {
          ...authorization,
          installation: { ...installation, awaitingShopSelection: false, selectedShopIds: ["777001"] },
        };
      },
      [`GET /v1/store-authorizations/${authorization.id}`]: () =>
        selected
          ? {
              ...authorization,
              status: "succeeded",
              result: {
                stores: [
                  {
                    storeId: "01JSTORE000000000000000001",
                    name: "Toko Terverifikasi",
                    externalShopId: "777001",
                    reconnected: false,
                  },
                ],
                skipped: [],
                failed: [],
              },
            }
          : { ...authorization, installation },
    });
    renderApp(<AppStoreInstallation />);
    expect(await screen.findByText("Toko Rina")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tinjau pemasangan" }));
    expect(screen.getByText(/Identitas toko belum diverifikasi/)).toBeInTheDocument();
    const connect = screen.getByRole("button", { name: "Verifikasi toko terlebih dahulu" });
    expect(connect).toBeDisabled();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    await user.click(screen.getByRole("checkbox"));
    await user.click(connect);
    expect(await screen.findByText("Identitas toko siap ditinjau")).toBeInTheDocument();
    expect(screen.queryByText("Toko berhasil terhubung")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tinjau dan pilih toko" }));
    expect(screen.getByText("ID toko: 777001 · Indonesia")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hubungkan 0 toko pilihan" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Hubungkan 1 toko pilihan" }));
    expect(await screen.findByText("Toko berhasil terhubung")).toBeInTheDocument();
    expect(screen.getByText("Toko Terverifikasi")).toBeInTheDocument();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      confirmationToken: challenge.confirmationToken,
      confirmed: true,
    });
    expect(calls.find((call) => call.path.endsWith("select-shops"))?.body).toEqual({
      authorizationId: authorization.id,
      confirmationToken: challenge.confirmationToken,
      confirmed: true,
      shopIds: ["777001"],
    });
  });

  it("never posts automatically and hides confirmation from a role without store management", async () => {
    const calls = mockApi({});
    renderApp(<AppStoreInstallation />, { me: testMe(["commerce:read"]) });
    expect(await screen.findByRole("alert")).toHaveTextContent("Anda memerlukan izin mengelola toko");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(0));
  });

  it("warns about partial quota failures and paginates connected, failed, and skipped shops", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /v1/store-installations/tiktokshop": () => challenge,
      "POST /v1/store-installations/tiktokshop/confirm": () => ({
        ...authorization,
        status: "succeeded",
        result: {
          stores: Array.from({ length: 4 }, (_, index) => ({
            storeId: `store-${index}`,
            externalShopId: `connected-${index}`,
            name: `Toko terhubung ${index + 1}`,
            reconnected: index === 3,
          })),
          failed: [
            { externalShopId: "failed-1", reason: "billing_limit_reached" },
            { externalShopId: "failed-2", reason: "billing_limit_reached" },
          ],
          skipped: [{ externalShopId: "skipped", region: "MY", reason: "region_not_supported" }],
        },
        installation: {
          awaitingShopSelection: false,
          selectedShopIds: [],
          shops: [
            { externalShopId: "failed-1", name: "Toko gagal pertama", region: "ID" },
            { externalShopId: "failed-2", name: "Toko gagal kedua", region: "ID" },
          ],
        },
      }),
    });
    renderApp(<AppStoreInstallation />);
    await user.click(await screen.findByRole("button", { name: "Tinjau pemasangan" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Verifikasi toko terlebih dahulu" }));
    expect(await screen.findByRole("heading", { name: "Sebagian toko belum terhubung" })).toBeInTheDocument();
    expect(screen.getByText("4 toko terhubung; 2 toko belum dapat dihubungkan.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Periksa hasil 2 toko");
    expect(screen.getByRole("status")).toHaveTextContent("Batas toko pada paket bisnis sudah tercapai");
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText("Toko gagal pertama")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Berikutnya" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("Terhubung ulang")).toBeInTheDocument();
    expect(within(list).getByText("Toko gagal pertama")).toBeInTheDocument();
    expect(within(list).getAllByText(/Batas toko pada paket bisnis sudah tercapai/)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Berikutnya" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Toko dilewati karena region MY belum didukung.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Berikutnya" })).toBeDisabled();
  });

  it("gives a clean restart explanation when capture failed and when the receipt expired", async () => {
    setUrl("/integrasi/instalasi/tiktokshop?capture=failed");
    const calls = mockApi({});
    const first = renderApp(<AppStoreInstallation />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Mulai pemasangan kembali dari App Store Seller Center");
    expect(calls).toHaveLength(0);
    first.unmount();
    setUrl("/integrasi/instalasi/tiktokshop");
    mockApi({
      "GET /v1/store-installations/tiktokshop": () =>
        problem(422, "store_authorization.invalid", "Waktu pemasangan habis."),
    });
    renderApp(<AppStoreInstallation />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Waktu pemasangan habis.");
  });
});
