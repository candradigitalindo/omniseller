import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { ALL_PERMISSIONS, type ApiCall, mockApi, renderApp, testMe } from "@/test/render";
import { periodRange, type StaffFigures, type StaffReport, todayIn } from "./report-meta";
import { StaffReportView } from "./staff-report";

const today = todayIn("Asia/Jakarta");
const month = periodRange("month", today) as { from: string; to: string };
const BUDI = "01JUSER0000000000000000002";
const RINA = "01JUSER0000000000000000001";

const figures = (over: Partial<StaffFigures> = {}): StaffFigures => ({
  processed: 0,
  packed: 0,
  packedByScan: 0,
  labels: 0,
  pickLists: 0,
  packingLists: 0,
  handedOver: 0,
  timedPacks: 0,
  packSecondsAverage: null,
  ...over,
});

const budi = figures({
  processed: 4,
  packed: 3,
  packedByScan: 2,
  pickLists: 5,
  handedOver: 3,
  timedPacks: 2,
  packSecondsAverage: 95,
});
const rina = figures({ processed: 2, packed: 1, labels: 6, packingLists: 6 });

function fixture(over: Partial<StaffReport> = {}): StaffReport {
  return {
    timezone: "Asia/Jakarta",
    range: { from: "2026-10-01", to: "2026-10-31" },
    packTimeLimitSeconds: 1800,
    total: figures({
      processed: 5,
      packed: 4,
      packedByScan: 2,
      labels: 6,
      pickLists: 5,
      packingLists: 6,
      handedOver: 3,
      timedPacks: 2,
      packSecondsAverage: 95,
    }),
    users: [
      { userId: BUDI, name: "Budi Santoso", ...budi },
      { userId: RINA, name: "Rina Wulandari", ...rina },
    ],
    days: [
      { date: "2026-10-01", ...figures({ processed: 3, labels: 6 }) },
      { date: "2026-10-02", ...figures({ processed: 2, packed: 4 }) },
    ],
    userDays: [
      { userId: BUDI, date: "2026-10-01", ...figures({ processed: 1 }) },
      { userId: RINA, date: "2026-10-01", ...figures({ processed: 2, labels: 6 }) },
      { userId: BUDI, date: "2026-10-02", ...figures({ processed: 3, packed: 3 }) },
    ],
    ...over,
  };
}

const reportCalls = (calls: ApiCall[]) => calls.filter((c) => c.path === "/v1/reports/staff");

describe("StaffReportView (L33)", () => {
  beforeEach(() => setUrl("/laporan/kinerja-tim"));

  it("shows the team's figures for this month and each member, most orders processed first", async () => {
    const calls = mockApi({ "GET /v1/reports/staff": () => fixture() });
    renderApp(<StaffReportView />);

    const kpis = await screen.findByRole("region", { name: "Angka tim" });
    expect(reportCalls(calls)[0]?.query).toEqual(month);
    expect(within(kpis).getByText("Pesanan diproses").parentElement).toHaveTextContent("5");
    expect(within(kpis).getByText("2 dengan scan")).toBeInTheDocument();
    expect(within(kpis).getByText("1,6 menit")).toBeInTheDocument();
    expect(within(kpis).getByText("rata-rata 2 kemas dengan scan")).toBeInTheDocument();
    expect(screen.getByText("Periode 1 Okt 2026 – 31 Okt 2026.")).toBeInTheDocument();

    const members = within(screen.getByRole("region", { name: "Per anggota tim" })).getAllByRole("row");
    expect(members.map((r) => r.textContent)).toEqual([
      "Anggota timDiprosesDikemasLabelPick listDaftar kemasKe kurirMenit/pesanan",
      "BSBudi Santoso43 (2 scan)05031,6",
      "RWRina Wulandari216060—",
    ]);
    expect(screen.getByText(/Hanya aksi di dalam OmniSeller yang dihitung/)).toBeInTheDocument();
    expect(screen.getByText(/Kemas lebih dari 30 menit dianggap terputus/)).toBeInTheDocument();
  });

  it("lists the team's days, or one member's, keeping the member in the URL", async () => {
    mockApi({ "GET /v1/reports/staff": () => fixture() });
    const user = userEvent.setup();
    renderApp(<StaffReportView />);
    const days = await screen.findByRole("region", { name: "Per hari" });
    expect(
      within(days)
        .getAllByRole("row")
        .map((r) => (r as HTMLTableRowElement).cells[0]?.textContent),
    ).toEqual(["Tanggal", "1 Okt 2026", "2 Okt 2026"]);
    expect(within(days).getAllByRole("row")[1]).toHaveTextContent("1 Okt 20263060");

    await user.click(screen.getByRole("combobox", { name: "Anggota tim" }));
    await user.click(await screen.findByRole("option", { name: "Budi Santoso" }));
    expect(currentUrl()).toBe(`/laporan/kinerja-tim?member=${BUDI}`);
    const rows = within(screen.getByRole("region", { name: "Per hari" })).getAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "TanggalDiprosesDikemasLabelPick listDaftar kemasKe kurirMenit/pesanan",
      "1 Okt 2026100000—",
      "2 Okt 2026330000—",
    ]);
  });

  it("shows the whole team for a member who did nothing in the period", async () => {
    setUrl(`/laporan/kinerja-tim?member=01JUSER0000000000000000009`);
    mockApi({ "GET /v1/reports/staff": () => fixture() });
    renderApp(<StaffReportView />);
    const days = await screen.findByRole("region", { name: "Per hari" });
    expect(within(days).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("combobox", { name: "Anggota tim" })).toHaveTextContent("Semua anggota tim");
  });

  it("asks for another period and downloads it per member or per member per day", async () => {
    const calls = mockApi({ "GET /v1/reports/staff": () => fixture() });
    const user = userEvent.setup();
    renderApp(<StaffReportView />);
    await screen.findByRole("region", { name: "Angka tim" });

    await user.click(screen.getByText("Bulan lalu"));
    const last = periodRange("last_month", today) as { from: string; to: string };
    expect(currentUrl()).toBe("/laporan/kinerja-tim?period=last_month");
    await waitFor(() => expect(reportCalls(calls).at(-1)?.query).toEqual(last));

    await user.click(screen.getByRole("button", { name: "Unduh" }));
    const perMember = await screen.findByRole("menuitem", { name: "Per anggota (CSV)" });
    expect(perMember).toHaveAttribute("href", `/v1/reports/staff/export?from=${last.from}&to=${last.to}&section=users`);
    expect(screen.getByRole("menuitem", { name: "Per anggota per hari (CSV)" })).toHaveAttribute(
      "href",
      `/v1/reports/staff/export?from=${last.from}&to=${last.to}&section=days`,
    );
    expect(screen.getByRole("menuitem", { name: "Excel (per anggota dan per hari)" })).toHaveAttribute(
      "href",
      `/v1/reports/staff/export?from=${last.from}&to=${last.to}&format=xlsx`,
    );
    await user.keyboard("{Escape}");
    expect(screen.getByRole("link", { name: "Jadwalkan email" })).toHaveAttribute("href", "/notifikasi");
  });

  it("names a member who left the business, and says so when nobody did anything", async () => {
    mockApi({
      "GET /v1/reports/staff": () =>
        fixture({ users: [{ userId: BUDI, name: null, ...budi }], userDays: [], days: [] }),
    });
    const { unmount } = renderApp(<StaffReportView />);
    expect(await screen.findAllByText("Pengguna tidak dikenal")).not.toHaveLength(0);
    unmount();

    mockApi({
      "GET /v1/reports/staff": () => fixture({ total: figures(), users: [], days: [], userDays: [] }),
    });
    renderApp(<StaffReportView />);
    expect(await screen.findByText("Belum ada aksi tim pada periode ini")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Angka tim" })).not.toBeInTheDocument();
  });

  it("says where the report is on plans without it, asking nothing", async () => {
    const calls = mockApi({ "GET /v1/reports/staff": () => fixture() });
    const me = { ...testMe(), plan: { code: "starter", name: "Starter", features: [] } };
    const { unmount } = renderApp(<StaffReportView />, { me });
    expect(screen.getByText("Tersedia mulai paket Growth")).toBeInTheDocument();
    expect(screen.getByText(/tidak termasuk paket Starter/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lihat paket" })).toHaveAttribute("href", "/langganan");
    unmount();
    // only who manages billing is sent there
    renderApp(<StaffReportView />, {
      me: { ...testMe(ALL_PERMISSIONS.filter((p) => p !== "settings:billing")), plan: me.plan },
    });
    expect(screen.queryByRole("link", { name: "Lihat paket" })).not.toBeInTheDocument();
    expect(reportCalls(calls)).toHaveLength(0);
  });

  it("is for whoever manages the team", async () => {
    const calls = mockApi({ "GET /v1/reports/staff": () => fixture() });
    renderApp(<StaffReportView />, { me: testMe(ALL_PERMISSIONS.filter((p) => p !== "settings:user")) });
    expect(screen.getByText(/hanya bisa dibuka pengguna yang boleh mengelola tim/)).toBeInTheDocument();
    expect(reportCalls(calls)).toHaveLength(0);
  });
});
