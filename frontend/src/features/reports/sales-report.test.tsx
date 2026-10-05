import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { ALL_PERMISSIONS, mockApi, problem, renderApp, testMe } from "@/test/render";
import { addDays, periodRange, type SalesReport, todayIn } from "./report-meta";
import { SalesReportView } from "./sales-report";

vi.mock("./trend-chart", () => ({
  TrendChart: ({ data }: { data: { labels: string[]; current: number[]; previous: (number | null)[] | null } }) => (
    <div data-testid="trend">
      {data.labels.join(",")}|{data.current.join(",")}|{data.previous?.join(",") ?? "none"}
    </div>
  ),
}));

const today = todayIn("Asia/Jakarta");
const month = periodRange("month", today) as { from: string; to: string };

function fixture(over: Partial<SalesReport> = {}): SalesReport {
  return {
    timezone: "Asia/Jakarta",
    range: { from: "2026-09-01", to: "2026-09-30" },
    granularity: "day",
    period: { from: "2026-08-31T17:00:00.000Z", to: "2026-09-30T17:00:00.000Z" },
    previousRange: { from: "2026-08-01", to: "2026-08-31" },
    previousPeriod: { from: "2026-07-31T17:00:00.000Z", to: "2026-08-31T17:00:00.000Z" },
    summary: {
      revenue: 1_250_000,
      orders: 10,
      units: 14,
      averageOrderValue: 125_000,
      paidOrders: 40,
      cancelledOrders: 1,
      cancellationRate: 2.5,
      shippedOrders: 9,
      shippedRevenue: 1_100_000,
      previous: null,
      change: { revenue: 25, orders: -10, averageOrderValue: 0, cancellationRate: 1 },
    },
    series: [
      { bucket: "2026-09-01", orders: 4, revenue: 500_000, previousOrders: 2, previousRevenue: 200_000 },
      { bucket: "2026-09-02", orders: 6, revenue: 750_000, previousOrders: 3, previousRevenue: 300_000 },
    ],
    byChannel: [
      { channel: "shopee", displayName: "Shopee", orders: 7, revenue: 1_000_000, share: 80 },
      { channel: "manual", displayName: "Penjualan langsung", orders: 3, revenue: 250_000, share: 20 },
    ],
    byStore: [],
    byProduct: [
      {
        variantId: "01JVARIANT0000000000000001",
        sku: "KAOS-HTM-L",
        name: "Kaos Polos",
        variantName: "Hitam, L",
        units: 9,
        orders: 6,
        revenue: 900_000,
      },
      {
        variantId: null,
        sku: "MP-ONLY-1",
        name: "Topi Rajut",
        variantName: null,
        units: 2,
        orders: 2,
        revenue: 80_000,
      },
    ],
    byCategory: [],
    byRegion: [{ province: "Jawa Barat", orders: 6, revenue: 750_000, share: 60 }],
    byHour: [
      { weekday: 1, hour: 20, orders: 4, revenue: 400_000 },
      { weekday: 5, hour: 9, orders: 1, revenue: 50_000 },
    ],
    ...over,
  };
}

const stores = {
  items: [
    {
      id: "01JSTORE000000000000000001",
      name: "Toko Rina Shopee",
      channel: "shopee",
      status: "active",
      syncMode: "live",
    },
    { id: "01JSTORE000000000000000002", name: "WhatsApp", channel: "manual", status: "active", syncMode: "live" },
  ],
};

function api(report: () => unknown = () => fixture()) {
  return mockApi({ "GET /v1/reports/sales": report, "GET /v1/stores": () => stores });
}

const reportCalls = (calls: { path: string; query: Record<string, string> }[]) =>
  calls.filter((c) => c.path === "/v1/reports/sales");

describe("SalesReportView (L30)", () => {
  beforeEach(() => setUrl("/laporan/penjualan"));

  it("compares this whole month with last month and shows the figures", async () => {
    const calls = api();
    renderApp(<SalesReportView />);

    expect(await screen.findByText("Rp 1.250.000")).toBeInTheDocument();
    expect(reportCalls(calls)[0]?.query).toEqual({ ...month, granularity: "day", compare: "true" });
    const kpis = screen.getByRole("region", { name: "Angka utama" });
    expect(within(kpis).getByText("+25%")).toBeInTheDocument();
    expect(within(kpis).getByText("-10%")).toBeInTheDocument();
    // the cancellation rate rises by a point: written in points, and red although it goes up
    expect(within(kpis).getByText("2,5%")).toBeInTheDocument();
    expect(within(kpis).getByText("+1 poin")).toHaveClass("text-danger");
    expect(within(kpis).getByText("+25%")).toHaveClass("text-success");
    expect(screen.getByText(/14 unit terjual\. 9 pesanan diserahkan ke kurir/)).toBeInTheDocument();
    expect(
      screen.getByText("Periode 1 Sep 2026 – 30 Sep 2026, dibanding 1 Agu 2026 – 31 Agu 2026."),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("trend")).toHaveTextContent("1 Sep,2 Sep|500000,750000|200000,300000");
  });

  it("asks again when the period, grouping, or comparison changes, keeping them in the URL", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<SalesReportView />);
    await screen.findByText("Rp 1.250.000");

    await user.click(screen.getByText("7 hari"));
    expect(currentUrl()).toBe("/laporan/penjualan?period=7d");
    await waitFor(() =>
      expect(reportCalls(calls).at(-1)?.query).toMatchObject({ from: addDays(today, -6), to: today }),
    );

    await user.click(screen.getByText("Minggu"));
    await waitFor(() => expect(reportCalls(calls).at(-1)?.query.granularity).toBe("week"));

    await user.click(screen.getByRole("switch", { name: "Bandingkan dengan periode sebelumnya" }));
    await waitFor(() => expect(reportCalls(calls).at(-1)?.query.compare).toBe("false"));
    expect(currentUrl()).toBe("/laporan/penjualan?period=7d&granularity=week&compare=false");

    await user.click(screen.getByText("Bulan ini"));
    expect(currentUrl()).toBe("/laporan/penjualan?granularity=week&compare=false");
  });

  it("reports one store, or every store of a channel, from the URL", async () => {
    setUrl("/laporan/penjualan?store=01JSTORE000000000000000001&channel=shopee");
    const calls = api();
    renderApp(<SalesReportView />);
    await screen.findByText("Rp 1.250.000");
    expect(reportCalls(calls)[0]?.query.storeId).toBe("01JSTORE000000000000000001");
    expect(reportCalls(calls)[0]?.query.channel).toBeUndefined();

    setUrl("/laporan/penjualan?channel=manual");
    await waitFor(() => expect(reportCalls(calls).at(-1)?.query.channel).toBe("manual"));
  });

  it("checks a custom period before asking for it", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<SalesReportView />);
    await screen.findByText("Rp 1.250.000");

    await user.click(screen.getByText("Kustom"));
    // starts from the dates on screen
    expect(currentUrl()).toBe(`/laporan/penjualan?period=custom&from=${month.from}&to=${month.to}`);
    const from = screen.getByLabelText("Dari tanggal");
    const to = screen.getByLabelText("Sampai tanggal");
    await user.clear(from);
    await user.type(from, "2026-08-20");
    await user.clear(to);
    await user.type(to, "2026-08-10");
    const before = reportCalls(calls).length;
    await user.click(screen.getByRole("button", { name: "Terapkan" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Tanggal mulai harus sebelum tanggal akhir.");
    expect(reportCalls(calls)).toHaveLength(before);

    await user.clear(to);
    await user.type(to, "2026-08-31");
    await user.click(screen.getByRole("button", { name: "Terapkan" }));
    await waitFor(() =>
      expect(reportCalls(calls).at(-1)?.query).toMatchObject({ from: "2026-08-20", to: "2026-08-31" }),
    );
  });

  it("breaks sales down per channel, product, and hour, each with its CSV", async () => {
    api();
    const user = userEvent.setup();
    renderApp(<SalesReportView />);
    await screen.findByText("Rp 1.250.000");

    // per channel: bars with the value and share at the tip
    expect(screen.getByText("Rp 1.000.000")).toBeInTheDocument();
    expect(screen.getByText("· 80%")).toBeInTheDocument();
    const csv = screen.getByRole("link", { name: "Unduh Per kanal sebagai CSV" });
    const href = new URL(csv.getAttribute("href") ?? "", "http://x");
    expect(href.pathname).toBe("/v1/reports/sales/export");
    expect(href.searchParams.get("section")).toBe("channels");
    expect(href.searchParams.get("from")).toBe(month.from);
    await user.click(screen.getByRole("button", { name: "Lihat tabel Per kanal" }));
    expect(within(screen.getByRole("tabpanel")).getAllByRole("columnheader", { name: "Porsi" }).length).toBeGreaterThan(
      0,
    );
    // the trend has its own table view
    expect(screen.getByRole("button", { name: "Lihat tabel Penjualan per periode" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Per produk" }));
    expect(currentUrl()).toBe("/laporan/penjualan?tab=products");
    expect(screen.getAllByText("KAOS-HTM-L").length).toBeGreaterThan(0);
    // a marketplace line without a product says so
    expect(screen.getAllByText(/belum terhubung ke produk/).length).toBeGreaterThan(0);

    // the table view stays on when moving between tabs: the busy hours as rows, busiest first
    await user.click(screen.getByRole("tab", { name: "Per jam" }));
    const rows = within(within(screen.getByRole("tabpanel")).getByRole("table")).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Senin20.00–20.594Rp 400.000");
    expect(rows[2]).toHaveTextContent("Jumat09.00–09.591Rp 50.000");
    await user.click(screen.getByRole("button", { name: "Lihat grafik Per jam" }));
    expect(
      screen.getByRole("img", { name: "Peta waktu ramai. Paling ramai hari Senin pukul 20.00 dengan 4 pesanan." }),
    ).toBeInTheDocument();
  });

  it("explains a store outside the user's scope", async () => {
    setUrl("/laporan/penjualan?store=01JSTORE000000000000000009");
    mockApi({
      "GET /v1/reports/sales": () => problem(404, "store.not_found", "Toko tidak ditemukan."),
      "GET /v1/stores": () => stores,
    });
    renderApp(<SalesReportView />);
    expect(await screen.findByText("Toko tidak ditemukan.")).toBeInTheDocument();
  });

  it("is closed to users who may not read reports", async () => {
    const calls = api();
    renderApp(<SalesReportView />, { me: testMe(ALL_PERMISSIONS.filter((p) => p !== "report:read")) });
    expect(screen.getByText(/hanya bisa dibuka pengguna yang punya izin melihat laporan/)).toBeInTheDocument();
    expect(reportCalls(calls)).toHaveLength(0);
  });
});
