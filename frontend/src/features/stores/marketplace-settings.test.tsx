import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { components } from "@/lib/api/schema";
import { mockApi, problem, renderApp } from "@/test/render";
import { MarketplaceSettings } from "./marketplace-settings";

type Application = components["schemas"]["MarketplaceApplicationListDto_Output"]["items"][number];
const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
function application(channel: "shopee" | "tiktokshop", over: Partial<Application> = {}): Application {
  return {
    channel,
    source: "unconfigured",
    applicationId: null,
    configured: false,
    environment: "production",
    partnerId: null,
    appKey: null,
    serviceId: null,
    secretConfigured: false,
    rowVersion: null,
    redirectUrl: `https://app.example.test/integrasi/callback/${channel}`,
    webhookUrl: null,
    settingsEnabled: true,
    ...over,
  };
}

describe("tenant marketplace settings", () => {
  it("saves Shopee credentials for the current business and never fills the secret back in", async () => {
    let items = [application("shopee"), application("tiktokshop")];
    const calls = mockApi({
      "GET /v1/marketplace-applications": () => ({ items }),
      "PUT /v1/marketplace-applications/shopee": () => {
        const updated = application("shopee", {
          source: "tenant",
          applicationId: id,
          configured: true,
          secretConfigured: true,
          partnerId: "123456",
          rowVersion: 1,
          webhookUrl: `https://hooks.example.test/webhooks/shopee/apps/${id}`,
        });
        items = [updated, items[1]!];
        return updated;
      },
    });
    const user = userEvent.setup();
    renderApp(<MarketplaceSettings open onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Atur kredensial Shopee" }));
    await user.type(screen.getByLabelText("Partner ID"), "123456");
    await user.type(screen.getByLabelText("Partner Key"), "PRIVATE_SHOPEE_KEY");
    await user.click(screen.getByRole("button", { name: "Simpan kredensial" }));
    await screen.findByText("Siap dihubungkan");
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      environment: "production",
      partnerId: "123456",
      secret: "PRIVATE_SHOPEE_KEY",
    });
    expect(screen.queryByDisplayValue("PRIVATE_SHOPEE_KEY")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Alamat callback" }));
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(`https://hooks.example.test/webhooks/shopee/apps/${id}`);
    await user.click(screen.getByRole("button", { name: "Kembali" }));
    await user.click(screen.getByRole("button", { name: "Atur kredensial Shopee" }));
    expect(screen.getByLabelText("Partner Key")).toHaveValue("");
    expect(screen.getByLabelText("Partner ID")).toHaveValue("123456");
  });

  it("requires a separate Service ID for Tokopedia & Shop and sends only its own fields", async () => {
    const tiktok = application("tiktokshop");
    const calls = mockApi({
      "GET /v1/marketplace-applications": () => ({ items: [tiktok] }),
      "PUT /v1/marketplace-applications/tiktokshop": () =>
        application("tiktokshop", {
          source: "tenant",
          applicationId: id,
          configured: true,
          secretConfigured: true,
          appKey: "tenant-app",
          serviceId: "service-123",
          rowVersion: 1,
        }),
    });
    const user = userEvent.setup();
    renderApp(<MarketplaceSettings open onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Atur kredensial Tokopedia & Shop" }));
    await user.type(screen.getByLabelText("App Key"), "tenant-app");
    await user.type(screen.getByLabelText("App Secret"), "PRIVATE_TIKTOK_SECRET");
    await user.click(screen.getByRole("button", { name: "Simpan kredensial" }));
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    expect(screen.getByText("Wajib diisi.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Service ID"), "service-123");
    await user.click(screen.getByRole("button", { name: "Simpan kredensial" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
        environment: "production",
        appKey: "tenant-app",
        serviceId: "service-123",
        secret: "PRIVATE_TIKTOK_SECRET",
      }),
    );
  });

  it("requires explicit deletion confirmation and sends the current revision", async () => {
    let item = application("shopee", {
      source: "tenant",
      applicationId: id,
      configured: true,
      secretConfigured: true,
      partnerId: "123456",
      rowVersion: 3,
    });
    const calls = mockApi({
      "GET /v1/marketplace-applications": () => ({ items: [item] }),
      "DELETE /v1/marketplace-applications/shopee": () => {
        item = { ...item, configured: false, secretConfigured: false, partnerId: null, rowVersion: 4 };
        return item;
      },
    });
    const user = userEvent.setup();
    renderApp(<MarketplaceSettings open onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Hapus kredensial Shopee" }));
    const dialog = screen.getByRole("dialog", { name: "Hapus kredensial marketplace?" });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Hapus kredensial" }));
    await screen.findByText("Belum diatur");
    expect(calls.find((call) => call.method === "DELETE")?.headers?.["if-match"]).toBe('"3"');
  });

  it("shows the server's active-connection guard instead of claiming a key replacement succeeded", async () => {
    const item = application("shopee", {
      source: "tenant",
      applicationId: id,
      configured: true,
      secretConfigured: true,
      partnerId: "123456",
      rowVersion: 2,
    });
    const calls = mockApi({
      "GET /v1/marketplace-applications": () => ({ items: [item] }),
      "PUT /v1/marketplace-applications/shopee": () =>
        problem(409, "marketplace_application.in_use", "Putuskan koneksi toko terlebih dahulu."),
    });
    const user = userEvent.setup();
    renderApp(<MarketplaceSettings open onClose={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Atur kredensial Shopee" }));
    await user.type(screen.getByLabelText("Partner Key"), "REPLACEMENT_PRIVATE_KEY");
    await user.click(screen.getByRole("button", { name: "Simpan kredensial" }));
    await screen.findByText("Putuskan koneksi toko terlebih dahulu.");
    expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({ expectedVersion: 2 });
    expect(screen.getByRole("button", { name: "Simpan kredensial" })).toBeEnabled();
  });
});
