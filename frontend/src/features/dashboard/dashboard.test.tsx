import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { components } from "@/lib/api/schema";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import { DashboardView } from "./dashboard";

vi.mock("./sales-chart", () => ({ SalesChart: () => <div /> }));

type Dashboard = components["schemas"]["DashboardDto_Output"];
function fixture(codOutstanding = { orders: 2, total: 345_000 }): Dashboard {
  return {
    timezone: "Asia/Jakarta",
    range: "today",
    generatedAt: "2026-10-03T08:00:00.000Z",
    period: {
      from: "2026-10-02T17:00:00.000Z",
      to: "2026-10-03T17:00:00.000Z",
      previousFrom: "2026-10-01T17:00:00.000Z",
      previousTo: "2026-10-02T17:00:00.000Z",
    },
    sales: null,
    grossProfit: null,
    salesChart: null,
    topProducts: null,
    criticalStock: null,
    orders: { statuses: { new: 1, shipped: 1 }, overdue: 0, dueSoon: 0, codOutstanding },
    urgentOrders: [],
    stores: [],
    tasks: [],
  };
}

describe("Dashboard COD summary", () => {
  it("shows the API's rupiah amount and order count without requiring finance permission", async () => {
    const calls = mockApi({ "GET /v1/dashboard": (c) => ({ ...fixture(), range: c.query.range }) });
    renderApp(<DashboardView />, { me: testMe(["order:read"]) });
    const kpis = await screen.findByRole("region", { name: "COD belum diterima" });
    expect(within(kpis).getByText("COD belum diterima")).toBeInTheDocument();
    expect(within(kpis).getByText(/Rp\s*345\.000/)).toBeInTheDocument();
    expect(within(kpis).getByText("2 pesanan · semua periode")).toBeInTheDocument();
    expect(screen.getByText(/Pembatalan dan retur tidak dihitung/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("radio", { name: "7 hari" }));
    await waitFor(() => expect(calls.at(-1)?.query.range).toBe("7d"));
    expect(await screen.findByText("2 pesanan · semua periode")).toBeInTheDocument();
  });

  it("shows zero when no COD is outstanding in an existing business", async () => {
    mockApi({ "GET /v1/dashboard": () => fixture({ orders: 0, total: 0 }) });
    renderApp(<DashboardView />);
    expect(await screen.findByText("0 pesanan · semua periode")).toBeInTheDocument();
    expect(screen.getByText(/Rp\s*0$/)).toBeInTheDocument();
  });

  it("shows a loading state and a recoverable API error instead of a misleading zero", async () => {
    let failed = true;
    const calls = mockApi({
      "GET /v1/dashboard": () => (failed ? problem(503, "dashboard.unavailable", "Coba lagi.") : fixture()),
    });
    renderApp(<DashboardView />);
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "Coba lagi" });
    expect(screen.queryByText("COD belum diterima")).not.toBeInTheDocument();
    failed = false;
    await userEvent.setup().click(retry);
    expect(await screen.findByText("2 pesanan · semua periode")).toBeInTheDocument();
    expect(calls).toHaveLength(2);
  });
});
