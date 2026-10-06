import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/navigation";
import { mockApi, renderApp, testMe } from "@/test/render";
import { PrintersView } from "./printers-view";

const AGENT = {
  id: "D1",
  name: "PC Kemas Jakarta",
  warehouseId: "W1",
  connected: true,
  lastSeenAt: "2026-10-06T00:00:00.000Z",
  appVersion: "1.2.0",
  printers: [
    { name: "Zebra GK420", isDefault: true },
    { name: "Epson L3110", isDefault: false },
  ],
  labelPrinter: "Zebra GK420",
  documentPrinter: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const TEMPLATE = { showSku: true, showVariant: true, showBin: false, showBuyerNote: true, showTags: false };

function api() {
  return mockApi({
    "GET /v1/print-agents": () => ({
      items: [AGENT, { ...AGENT, id: "D2", name: "Laptop Kasir", connected: false, printers: [] }],
    }),
    "GET /v1/warehouses": () => ({ items: [{ id: "W1", name: "Gudang Jakarta" }] }),
    "PATCH /v1/print-agents/D1": (c) => ({ ...AGENT, ...(c.body as object) }),
    "POST /v1/print-agents/D1/test-print": () => ({ id: "J1", printer: "Zebra GK420" }),
    "DELETE /v1/print-agents/D1": () => undefined,
    "POST /v1/print-agents": () => ({ agent: { ...AGENT, id: "D3", name: "PC Baru" }, token: "osd_live_8f2a91c4e7b0" }),
    "GET /v1/label-template": () => TEMPLATE,
    "PUT /v1/label-template": (c) => ({ ...TEMPLATE, ...(c.body as object) }),
  });
}

describe("PrintersView (L42)", () => {
  beforeEach(() => setUrl("/printer"));

  it("shows agents with their state, and test prints on a connected one", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<PrintersView />);
    expect(await screen.findByText("PC Kemas Jakarta")).toBeInTheDocument();
    const laptop = screen.getByText("Laptop Kasir").closest("[data-slot=card]") as HTMLElement;
    expect(within(laptop).getByText("Terputus")).toBeInTheDocument();
    expect(within(laptop).getByRole("button", { name: "Cetak percobaan" })).toBeDisabled();
    const pc = screen.getByText("PC Kemas Jakarta").closest("[data-slot=card]") as HTMLElement;
    await user.click(within(pc).getByRole("button", { name: "Cetak percobaan" }));
    expect(await screen.findByText("Halaman percobaan dikirim ke Zebra GK420.")).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith("/test-print"))?.body).toEqual({ printer: "Zebra GK420" });
  });

  it("chooses the document printer of an agent", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<PrintersView />);
    const pc = (await screen.findByText("PC Kemas Jakarta")).closest("[data-slot=card]") as HTMLElement;
    await user.click(within(pc).getByRole("combobox", { name: "Printer dokumen (A4)" }));
    await user.click(await screen.findByRole("option", { name: "Epson L3110" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ documentPrinter: "Epson L3110" }),
    );
  });

  it("pairs an agent and shows its code once", async () => {
    const calls = api();
    const user = userEvent.setup();
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    renderApp(<PrintersView />);
    await user.click((await screen.findAllByRole("button", { name: "Pasang agen cetak" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nama agen"), "PC Baru");
    await user.click(within(dialog).getByRole("button", { name: "Buat kode" }));
    expect(await within(dialog).findByText("osd_live_8f2a91c4e7b0")).toBeInTheDocument();
    expect(within(dialog).getByText(/hanya tampil sekali/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Salin" }));
    expect(write).toHaveBeenCalledWith("osd_live_8f2a91c4e7b0");
    expect(calls.find((c) => c.method === "POST" && c.path === "/v1/print-agents")?.body).toEqual({
      name: "PC Baru",
      warehouseId: null,
    });
  });

  it("revokes an agent after asking", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<PrintersView />);
    const pc = (await screen.findByText("PC Kemas Jakarta")).closest("[data-slot=card]") as HTMLElement;
    await user.click(within(pc).getByRole("button", { name: "Cabut" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cabut" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("turns on the bin location in the label strip and reloads the preview", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<PrintersView />);
    const preview = await screen.findByTitle("Contoh label dengan template ini");
    expect(preview).toHaveAttribute("src", "/v1/label-template/preview?format=thermal&v=0");
    await user.click(await screen.findByRole("switch", { name: /Lokasi rak/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ showBin: true }));
    await waitFor(() =>
      expect(screen.getByTitle("Contoh label dengan template ini")).toHaveAttribute(
        "src",
        "/v1/label-template/preview?format=thermal&v=1",
      ),
    );
    await user.click(screen.getByText("A4"));
    expect(screen.getByTitle("Contoh label dengan template ini").getAttribute("src")).toContain("format=a4");
  });

  it("lets a packer test print but not pair, rename, or change the template", async () => {
    api();
    renderApp(<PrintersView />, { me: testMe(["shipment:print"]) });
    expect(await screen.findByText("PC Kemas Jakarta")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pasang agen cetak" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cabut" })).not.toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: /Lokasi rak/ })).toBeDisabled();
  });
});
