import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { type ApiCall, mockApi, renderApp, testMe } from "@/test/render";
import { AuditLogView } from "./audit-log-view";
import { entry } from "./fixtures";

const RINA = { type: "user" as const, id: "01JUSER0000000000000000000", name: "Rina Wulandari" };
const BUDI = { type: "user" as const, id: "01JUSER0000000000000000002", name: "Budi Santoso" };
const PEOPLE = { items: [BUDI, RINA].map(({ id, name }) => ({ id, name })) };

const PRICE = entry({
  requestId: "R1",
  changes: [
    { field: "costPrice", before: null, after: null, hidden: true },
    { field: "basePrice", before: 65_000, after: 69_000 },
  ],
});
const PRICE_M = entry({
  requestId: "R1",
  label: "KAOS-HTM-M",
  changes: [{ field: "basePrice", before: 65_000, after: 69_000 }],
});
const ADJUSTED = entry({
  requestId: "R2",
  actor: BUDI,
  actorId: BUDI.id,
  entityType: "stock_movement",
  action: "insert",
  change: "created",
  label: "KAOS-HTM-L",
  changes: [
    { field: "variant", before: null, after: "KAOS-HTM-L" },
    { field: "warehouse", before: null, after: "Gudang Jakarta" },
    { field: "type", before: null, after: "adjustment" },
    { field: "onHandDelta", before: null, after: -2 },
    { field: "reason", before: null, after: "damaged" },
  ],
});
const DISCONNECTED = entry({
  entityType: "store",
  label: "Toko Rina Shopee",
  changes: [{ field: "status", before: "active", after: "disconnected" }],
});
const CONNECTED = entry({
  actor: { type: "system", id: "system", name: null },
  actorType: "system",
  entityType: "store",
  action: "insert",
  change: "created",
  label: "Toko Rina TTS",
  changes: [
    { field: "channel", before: null, after: "tiktokshop" },
    { field: "name", before: null, after: "Toko Rina TTS" },
    { field: "status", before: null, after: "active" },
  ],
});

const PROFILE_CHANGED = entry({
  entityType: "business_profile",
  label: null,
  changes: [
    { field: "logo", before: "01JFILE0000000000000000001", after: "01JFILE0000000000000000002" },
    { field: "nibInProcessSince", before: null, after: "2026-05-01" },
  ],
});

const logCalls = (calls: ApiCall[]) => calls.filter((c) => c.path === "/v1/audit-logs");

beforeEach(() => setUrl("/log-audit"));

describe("Log Audit", () => {
  it("says who did what, one block per action, in the seller's words", async () => {
    mockApi({
      "GET /v1/audit-logs/people": () => PEOPLE,
      "GET /v1/audit-logs": () => ({ items: [PRICE, PRICE_M, ADJUSTED, DISCONNECTED, CONNECTED], next_cursor: null }),
    });
    renderApp(<AuditLogView />);
    const log = await screen.findByRole("list", { name: "Log Audit" });
    const blocks = within(log)
      .getAllByRole("listitem")
      .filter((li) => li.parentElement === log);
    expect(blocks).toHaveLength(4);

    // two variants changed in one save: one block, the person named once
    const [saved, adjusted, disconnected, connected] = blocks as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(within(saved).getAllByText("Rina Wulandari")).toHaveLength(1);
    expect(within(saved).getByText("KAOS-HTM-L")).toBeInTheDocument();
    expect(within(saved).getByText("KAOS-HTM-M")).toBeInTheDocument();
    expect(within(saved).getAllByText("Rp 65.000 → Rp 69.000")).toHaveLength(2);
    // a reader without finance:read: the api hid the cost price
    expect(within(saved).getByText("disembunyikan")).toBeInTheDocument();

    expect(within(adjusted).getByText("Budi Santoso")).toBeInTheDocument();
    expect(within(adjusted).getByText(/Menyesuaikan stok/)).toBeInTheDocument();
    expect(within(adjusted).getByText("Gudang Jakarta")).toBeInTheDocument();
    expect(within(adjusted).getByText("-2")).toBeInTheDocument();
    expect(within(adjusted).getByText("Rusak")).toBeInTheDocument();
    // the variant repeats the entry's own name, so it is not listed again
    expect(within(adjusted).queryByText("Varian:")).not.toBeInTheDocument();

    expect(within(disconnected).getByText(/Memutus toko/)).toBeInTheDocument();
    expect(within(disconnected).getByText("Aktif → Terputus")).toBeInTheDocument();

    expect(within(connected).getByText("Sistem")).toBeInTheDocument();
    expect(within(connected).getByText("Tokopedia & Shop")).toBeInTheDocument();
  });

  it("says a file was replaced instead of showing its id, and dates without a time", async () => {
    mockApi({
      "GET /v1/audit-logs/people": () => PEOPLE,
      "GET /v1/audit-logs": () => ({ items: [PROFILE_CHANGED], next_cursor: null }),
    });
    renderApp(<AuditLogView />);
    expect(await screen.findByText("Mengubah profil bisnis")).toBeInTheDocument();
    expect(screen.getByText("diganti")).toBeInTheDocument();
    expect(screen.getByText("— → 1 Mei 2026")).toBeInTheDocument();
    expect(screen.queryByText(/01JFILE/)).not.toBeInTheDocument();
  });

  it("reads courier cut-offs and holidays as times, days, and dates", async () => {
    mockApi({
      "GET /v1/audit-logs/people": () => PEOPLE,
      "GET /v1/audit-logs": () => ({
        items: [
          entry({
            entityType: "courier_cutoff",
            change: "created",
            action: "insert",
            label: "SiCepat",
            changes: [
              { field: "cutoffTime", before: null, after: "16:00:00" },
              { field: "daysOfWeek", before: null, after: [1, 2, 3, 4, 5] },
            ],
          }),
          entry({
            entityType: "courier_holiday",
            change: "created",
            action: "insert",
            requestId: "req-holiday",
            label: "2026-12-25",
            changes: [{ field: "note", before: null, after: "Natal" }],
          }),
        ],
        next_cursor: null,
      }),
    });
    renderApp(<AuditLogView />);
    expect(await screen.findByText("Menambah cut-off kurir")).toBeInTheDocument();
    expect(screen.getByText("16.00")).toBeInTheDocument();
    expect(screen.getByText("Sen, Sel, Rab, Kam, Jum")).toBeInTheDocument();
    expect(screen.getByText("25 Des 2026")).toBeInTheDocument();
    expect(screen.queryByText("2026-12-25")).not.toBeInTheDocument();
  });

  it("narrows by kind, person, and period through the address and the api", async () => {
    const calls = mockApi({
      "GET /v1/audit-logs/people": () => PEOPLE,
      "GET /v1/audit-logs": () => ({ items: [ADJUSTED], next_cursor: null }),
    });
    const user = userEvent.setup();
    renderApp(<AuditLogView />);
    await screen.findByRole("list", { name: "Log Audit" });
    expect(logCalls(calls)[0]?.query).toEqual({ limit: "50" });

    await user.click(screen.getByRole("combobox", { name: "Jenis perubahan" }));
    await user.click(await screen.findByRole("option", { name: "Stok" }));
    expect(currentUrl()).toBe("/log-audit?kind=stock");
    await waitFor(() =>
      expect(logCalls(calls).at(-1)?.query).toEqual({
        limit: "50",
        entity_type: "stock_movement,stock_count,stock_transfer,stock_allocation_rule",
      }),
    );

    await user.click(screen.getByRole("combobox", { name: "Pelaku" }));
    await user.click(await screen.findByRole("option", { name: "Budi Santoso" }));
    expect(currentUrl()).toBe(`/log-audit?kind=stock&actor=${BUDI.id}`);
    await waitFor(() => expect(logCalls(calls).at(-1)?.query.actor_id).toBe(BUDI.id));

    const before = Date.now();
    await user.click(screen.getByRole("combobox", { name: "Periode" }));
    await user.click(await screen.findByRole("option", { name: "7 hari terakhir" }));
    await waitFor(() => expect(logCalls(calls).at(-1)?.query.from).toBeDefined());
    const from = Date.parse(String(logCalls(calls).at(-1)?.query.from));
    expect(Math.abs(before - 7 * 86_400_000 - from)).toBeLessThan(60_000);

    await user.click(screen.getByRole("button", { name: "Hapus filter" }));
    expect(currentUrl()).toBe("/log-audit");
  });

  it("ignores a person in the address that is not an id, rather than asking the api", async () => {
    setUrl("/log-audit?actor=bukan-id");
    const calls = mockApi({
      "GET /v1/audit-logs/people": () => PEOPLE,
      "GET /v1/audit-logs": () => ({ items: [], next_cursor: null }),
    });
    renderApp(<AuditLogView />);
    expect(await screen.findByText("Belum ada catatan.")).toBeInTheDocument();
    expect(logCalls(calls)[0]?.query).toEqual({ limit: "50" });
  });

  it("folds a long action and shows the rest on request", async () => {
    const system = { type: "system" as const, id: "system", name: null };
    const signup = Array.from({ length: 8 }, (_, i) =>
      entry({
        requestId: "SIGNUP",
        actor: system,
        actorType: "system",
        entityType: "role_permission",
        action: "insert",
        change: "created",
        label: "Owner",
        changes: [
          { field: "role", before: null, after: "Owner" },
          { field: "permission", before: null, after: `Izin ${i + 1}` },
        ],
      }),
    );
    mockApi({
      "GET /v1/audit-logs/people": () => PEOPLE,
      "GET /v1/audit-logs": () => ({ items: signup, next_cursor: null }),
    });
    const user = userEvent.setup();
    renderApp(<AuditLogView />);
    await screen.findByText("Izin 1");
    expect(screen.getAllByText(/Menambah izin peran/)).toHaveLength(3);
    expect(screen.queryByText("Izin 4")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tampilkan 5 perubahan lain" }));
    expect(screen.getAllByText(/Menambah izin peran/)).toHaveLength(8);
    expect(screen.getByText("Izin 8")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sembunyikan" })).toHaveAttribute("aria-expanded", "true");
  });

  it("reads on past a page with nothing to show, and loads older entries on request", async () => {
    const OLDER = entry({ label: "KAOS-PTH-L" });
    const calls = mockApi({
      "GET /v1/audit-logs/people": () => PEOPLE,
      "GET /v1/audit-logs": (c) => {
        if (!c.query.cursor) return { items: [], next_cursor: "C1" };
        if (c.query.cursor === "C1") return { items: [PRICE], next_cursor: "C2" };
        return { items: [OLDER], next_cursor: null };
      },
    });
    const user = userEvent.setup();
    renderApp(<AuditLogView />);
    expect(await screen.findByText("KAOS-HTM-L")).toBeInTheDocument();
    expect(logCalls(calls).map((c) => c.query.cursor)).toEqual([undefined, "C1"]);

    await user.click(screen.getByRole("button", { name: "Muat lebih banyak" }));
    expect(await screen.findByText("KAOS-PTH-L")).toBeInTheDocument();
    expect(logCalls(calls).map((c) => c.query.cursor)).toEqual([undefined, "C1", "C2"]);
    expect(screen.queryByRole("button", { name: "Muat lebih banyak" })).not.toBeInTheDocument();
  });

  it("is only for readers of the audit log", async () => {
    const calls = mockApi({});
    renderApp(<AuditLogView />, { me: testMe(["order:read", "settings:user"]) });
    expect(screen.getByText(/Hanya pengguna dengan izin log audit/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
