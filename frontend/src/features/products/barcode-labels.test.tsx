import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiCall, mockApi, problem, renderApp } from "@/test/render";
import { BarcodeLabelsDialog, type LabelVariant } from "./barcode-labels";

const AGENT = "01JDEVICE00000000000000001";
const VARIANTS: LabelVariant[] = [
  { id: "01JVARIANT0000000000000001", sku: "KAOS-HTM-L", name: "Hitam, L", barcode: "8991234567891" },
  { id: "01JVARIANT0000000000000002", sku: "KAOS-PTH-L", name: "Putih, L", barcode: null },
];
const DOC = {
  id: "01JDOC0000000000000000009",
  kind: "barcode_labels",
  status: "queued",
  format: "thermal",
  labelFormat: "a4_3x10",
  template: "standard",
  packingList: false,
  orderCount: 0,
  pageCount: null,
  result: { missing: [], dense: [] },
  error: null,
  downloadUrl: null,
  printJob: null,
};

function api(extra: Record<string, (c: ApiCall) => unknown> = {}) {
  return mockApi({
    "GET /v1/print-agents": () => ({
      items: [{ id: AGENT, name: "PC Gudang", connected: true, printers: [], createdAt: "2026-10-01T00:00:00.000Z" }],
    }),
    "POST /v1/documents/barcode-labels": () => Response.json(DOC, { status: 202 }),
    [`GET /v1/documents/${DOC.id}`]: () => ({
      ...DOC,
      status: "ready",
      pageCount: 1,
      downloadUrl: "/v1/files/01JFILE0000000000000000009/download",
    }),
    ...extra,
  });
}
const sent = (calls: ApiCall[]) => calls.filter((c) => c.path === "/v1/documents/barcode-labels");

afterEach(() => localStorage.clear());

describe("Cetak label barcode", () => {
  it("makes a PDF of the labels chosen per variant, a variant without a barcode by its SKU", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<BarcodeLabelsDialog open variants={VARIANTS} onClose={vi.fn()} />);

    expect(screen.getByText("8991234567891")).toBeInTheDocument();
    expect(screen.getByText("Memakai SKU")).toBeInTheDocument();
    const first = screen.getByLabelText("Jumlah label KAOS-HTM-L");
    await user.clear(first);
    await user.type(first, "3");
    await user.clear(screen.getByLabelText("Jumlah label KAOS-PTH-L"));
    await user.click(screen.getByText("A4, 30 label"));
    await user.click(screen.getByRole("button", { name: "Buat PDF 3 label" }));

    await waitFor(() => expect(sent(calls)).toHaveLength(1));
    expect(sent(calls)[0]?.body).toEqual({
      items: [{ variantId: VARIANTS[0]!.id, copies: 3 }],
      format: "a4_3x10",
    });
    expect(await screen.findByRole("link", { name: "Unduh PDF" })).toHaveAttribute(
      "href",
      "/v1/files/01JFILE0000000000000000009/download",
    );
  });

  it("prints on this station's agent when it has one", async () => {
    localStorage.setItem(
      "omniseller.print",
      JSON.stringify({ deviceId: AGENT, format: "thermal", template: "standard", packingList: false }),
    );
    const calls = api();
    const user = userEvent.setup();
    renderApp(<BarcodeLabelsDialog open variants={VARIANTS} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Cetak 2 label" }));
    await waitFor(() => expect(sent(calls)).toHaveLength(1));
    expect(sent(calls)[0]?.body).toEqual({
      items: [
        { variantId: VARIANTS[0]!.id, copies: 1 },
        { variantId: VARIANTS[1]!.id, copies: 1 },
      ],
      format: "label_50x30",
      print: { deviceId: AGENT, copies: 1 },
    });
  });

  it("asks for readable counts within 2,000 labels before asking the api", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<BarcodeLabelsDialog open variants={VARIANTS} onClose={vi.fn()} />);
    const first = screen.getByLabelText("Jumlah label KAOS-HTM-L");
    await user.clear(first);
    await user.type(first, "2,5");
    expect(screen.getByRole("alert")).toHaveTextContent("Jumlah label berupa bilangan bulat 0 sampai 500.");
    expect(first).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /PDF/ })).toBeDisabled();

    await user.clear(first);
    await user.clear(screen.getByLabelText("Jumlah label KAOS-PTH-L"));
    // nothing chosen, nothing to make
    expect(screen.getByRole("button", { name: "Buat PDF 0 label" })).toBeDisabled();
    expect(sent(calls)).toHaveLength(0);
  });

  it("shows the api's refusal", async () => {
    api({
      "POST /v1/documents/barcode-labels": () =>
        problem(422, "validation.failed", "Paling banyak 2.000 label per dokumen."),
    });
    const user = userEvent.setup();
    renderApp(<BarcodeLabelsDialog open variants={VARIANTS} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Buat PDF 2 label" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Paling banyak 2.000 label per dokumen.");
  });
});
