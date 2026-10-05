import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/navigation";
import { mockApi, renderApp } from "@/test/render";
import { CountDetailView } from "./count-detail";
import { COUNT_ID, countFixture, lineFixture } from "./fixtures";

const lines = [
  lineFixture(),
  lineFixture({
    id: "01JCLINE000000000000000002",
    variantId: "01JVARIANT0000000000000002",
    sku: "KAOS-PTH-L",
    variantName: "Putih, L",
    countedQty: 4,
  }),
];

function api(count = countFixture(), items = lines) {
  return mockApi({
    [`GET /v1/stock-counts/${COUNT_ID}`]: () => count,
    [`GET /v1/stock-counts/${COUNT_ID}/lines`]: () => ({ items, next_cursor: null }),
    [`PUT /v1/stock-counts/${COUNT_ID}/lines`]: () => ({ items: [lineFixture({ countedQty: 7 })] }),
    [`POST /v1/stock-counts/${COUNT_ID}/scan`]: (call) => ({
      matchedBy: "barcode",
      line: lineFixture({ countedQty: (call.body as { qty: number }).qty }),
    }),
    [`POST /v1/stock-counts/${COUNT_ID}/submit`]: () => countFixture({ status: "review" }),
    [`POST /v1/stock-counts/${COUNT_ID}/apply`]: () =>
      countFixture({ status: "review", applyRequestedAt: "2026-10-05T02:00:00.000Z" }),
  });
}

describe("CountDetailView", () => {
  beforeEach(() => setUrl(`/stok/opname/${COUNT_ID}`));

  it("hides the system's numbers while a blind count is counted, and records a typed count", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<CountDetailView id={COUNT_ID} />);

    const input = await screen.findByLabelText("Jumlah dihitung KAOS-HTM-L");
    expect(screen.queryByRole("columnheader", { name: "Sistem" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Selisih" })).toBeNull();
    await user.type(input, "7{Enter}");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      lines: [{ variantId: "01JVARIANT0000000000000001", qty: 7, mode: "set" }],
    });
  });

  it("sends repeated scans of one code as one request", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<CountDetailView id={COUNT_ID} />);

    const box = await screen.findByLabelText("Pindai barcode atau ketik SKU, lalu Enter");
    await user.type(box, "8991234567891{Enter}");
    await user.type(box, "8991234567891{Enter}");
    await user.type(box, "8991234567891{Enter}");
    expect(await screen.findByText("Menunggu dikirim: 8991234567891 ×3")).toBeInTheDocument();
    expect(await screen.findByText(/\+3 KAOS-HTM-L/, {}, { timeout: 3_000 })).toBeInTheDocument();
    const scans = calls.filter((c) => c.path.endsWith("/scan"));
    expect(scans.map((c) => c.body)).toEqual([{ code: "8991234567891", qty: 3 }]);
  });

  it("applies a reviewed count after confirming, with uncounted SKUs as zero when asked", async () => {
    const reviewed = countFixture({
      status: "review",
      stats: { lines: 2, counted: 1, differences: 1, added: 0 },
      difference: { unitsOver: 0, unitsUnder: 3, value: 105_000 },
    });
    const calls = api(reviewed, [lineFixture({ expectedQty: 10, countedQty: 7, diff: -3 })]);
    const user = userEvent.setup();
    renderApp(<CountDetailView id={COUNT_ID} />);

    expect(await screen.findByText("-3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Terapkan selisih" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Rp 105.000")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: /Anggap 1 SKU yang tidak dihitung habis/ }));
    await user.click(within(dialog).getByRole("button", { name: "Terapkan" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/apply"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/apply"))?.body).toEqual({ zeroUncounted: true });
  });
});
