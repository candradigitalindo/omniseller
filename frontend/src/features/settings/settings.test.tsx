import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/navigation";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import { DataExportView, formatSize } from "./data-export";
import { NotificationSettingsView } from "./notification-settings";

describe("NotificationSettingsView (L44)", () => {
  beforeEach(() => setUrl("/notifikasi"));

  const prefs = () => ({
    items: [
      {
        kind: "digest.daily",
        label: "Ringkasan harian",
        email: true,
        emailByDefault: true,
        locked: false,
        inApp: "always",
        feature: null,
      },
      {
        kind: "store.connection_lost",
        label: "Toko terputus",
        email: true,
        emailByDefault: true,
        locked: true,
        inApp: "always",
        feature: null,
      },
      {
        kind: "report.sales_weekly",
        label: "Laporan penjualan mingguan",
        email: false,
        emailByDefault: false,
        locked: false,
        inApp: "with_email",
        feature: null,
      },
      {
        kind: "report.staff_weekly",
        label: "Laporan kinerja tim mingguan",
        email: false,
        emailByDefault: false,
        locked: false,
        inApp: "with_email",
        feature: "staff_report",
      },
    ],
  });

  it("turns the daily email off, and keeps always-sent kinds locked", async () => {
    const calls = mockApi({
      "GET /v1/notifications/preferences": prefs,
      "PUT /v1/notifications/preferences/digest.daily": () => ({ kind: "digest.daily", email: false }),
    });
    const user = userEvent.setup();
    renderApp(<NotificationSettingsView />);
    expect(await screen.findByRole("switch", { name: "Email untuk Toko terputus" })).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Email untuk Ringkasan harian" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ email: false }));
    expect(screen.getByRole("switch", { name: "Email untuk Ringkasan harian" })).not.toBeChecked();
  });

  it("offers the scheduled reports as email only, locked while the plan lacks the team report", async () => {
    const calls = mockApi({
      "GET /v1/notifications/preferences": prefs,
      "PUT /v1/notifications/preferences/report.sales_weekly": () => ({ items: [] }),
    });
    const user = userEvent.setup();
    renderApp(<NotificationSettingsView />, {
      me: { ...testMe(), plan: { code: "starter", name: "Starter", features: [] } },
    });
    const sales = await screen.findByRole("switch", { name: "Email untuk Laporan penjualan mingguan" });
    // a report exists only as an email: no check in the app column
    const row = sales.closest("tr")!;
    expect(row).toHaveTextContent("Bersama email");
    expect(screen.getAllByText("Selalu muncul di aplikasi")).toHaveLength(2);
    await user.click(sales);
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/v1/notifications/preferences/report.sales_weekly")?.body).toEqual({
        email: true,
      }),
    );
    // the team report needs plan Growth: locked, and said so
    const staff = screen.getByRole("switch", { name: "Email untuk Laporan kinerja tim mingguan" });
    expect(staff).toBeDisabled();
    expect(staff.closest("tr")).toHaveTextContent("Tersedia mulai paket Growth.");
  });

  it("puts the switch back when the api refuses", async () => {
    mockApi({
      "GET /v1/notifications/preferences": prefs,
      "PUT /v1/notifications/preferences/digest.daily": () => problem(409, "x", "Tidak bisa disimpan."),
    });
    const user = userEvent.setup();
    renderApp(<NotificationSettingsView />);
    await user.click(await screen.findByRole("switch", { name: "Email untuk Ringkasan harian" }));
    expect(await screen.findByText("Tidak bisa disimpan.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Email untuk Ringkasan harian" })).toBeChecked();
  });
});

describe("DataExportView (FR-MIG-09)", () => {
  beforeEach(() => setUrl("/ekspor"));

  const ready = {
    id: "E1",
    status: "ready",
    requestedBy: null,
    createdAt: "2026-10-06T01:00:00.000Z",
    finishedAt: "2026-10-06T01:00:05.000Z",
    expiresAt: "2026-10-13T01:00:00.000Z",
    expired: false,
    sizeBytes: 1_258_291,
    files: [
      { name: "produk.csv", rows: 120 },
      { name: "pesanan.csv", rows: 840 },
    ],
    error: null,
    downloadCount: 0,
    lastDownloadedAt: null,
    downloadUrl: "/v1/exports/E1/download",
  };

  it("lists exports with their files and starts a new one", async () => {
    const calls = mockApi({
      "GET /v1/exports": () => ({ items: [ready] }),
      "POST /v1/exports": () => ({ ...ready, id: "E2", status: "queued", downloadUrl: null }),
    });
    const user = userEvent.setup();
    renderApp(<DataExportView />);
    expect(await screen.findByText(/2 berkas CSV · 1,2 MB/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Unduh ZIP" })).toHaveAttribute("href", "/v1/exports/E1/download");
    await user.click(screen.getByRole("button", { name: "Buat ekspor" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(await screen.findByText(/Ekspor sedang disiapkan/)).toBeInTheDocument();
  });

  it("waits for a running export before another", async () => {
    mockApi({ "GET /v1/exports": () => ({ items: [{ ...ready, status: "running", downloadUrl: null }] }) });
    renderApp(<DataExportView />);
    expect(await screen.findByText("Disiapkan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buat ekspor" })).toBeDisabled();
  });

  it("is for the owner only", () => {
    mockApi({});
    renderApp(<DataExportView />, { me: testMe(["order:read"]) });
    expect(screen.getByText("Hanya pemilik bisnis yang bisa mengekspor seluruh data.")).toBeInTheDocument();
  });

  it("writes sizes in KB and MB", () => {
    expect(formatSize(1_258_291)).toBe("1,2 MB");
    expect(formatSize(860_000)).toBe("840 KB");
    expect(formatSize(10)).toBe("1 KB");
  });
});
