import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { type ApiCall, mockApi, renderApp } from "@/test/render";
import type { SyncJob } from "./store-admin-meta";
import { SyncLog } from "./sync-log";

const STORE = "01JSTORE000000000000000001";

function job(over: Partial<SyncJob>): SyncJob {
  return {
    id: "01JSYNC0000000000000000001",
    kind: "orders.pull",
    direction: "pull",
    status: "succeeded",
    startedAt: "2026-10-06T03:15:00.000Z",
    finishedAt: "2026-10-06T03:15:01.200Z",
    durationMs: 1_200,
    attempts: 1,
    errorCode: null,
    errorMessage: null,
    result: null,
    calls: [],
    ...over,
  };
}
const PULLED = job({
  calls: [
    { method: "GET", path: "/api/v2/order/get_order_list?access_token=[redacted]", httpStatus: 200, durationMs: 310 },
  ],
});
const FAILED = job({
  id: "01JSYNC0000000000000000002",
  kind: "stock.push",
  direction: "push",
  status: "failed",
  durationMs: 420,
  attempts: 3,
  errorCode: "error_server",
  errorMessage: "Shopee sedang sibuk. OmniSeller mencoba lagi otomatis.",
});
const ODD = job({ id: "01JSYNC0000000000000000003", kind: "orders.mystery", status: "skipped", durationMs: null });
const PARTLY = job({
  id: "01JSYNC0000000000000000004",
  kind: "stock.push",
  direction: "push",
  result: { ok: 4, failed: [{ item: "702", variant: "7021", error: "Stok di bawah cadangan promo." }] },
});

const logCalls = (calls: ApiCall[]) => calls.filter((c) => c.path === `/v1/stores/${STORE}/sync-jobs`);

beforeEach(() => setUrl(`/integrasi/${STORE}?tab=log`));

describe("Log sinkron", () => {
  it("lists each piece of work in words, with its outcome, time taken, and reason", async () => {
    mockApi({
      [`GET /v1/stores/${STORE}/sync-jobs`]: () => ({ items: [PULLED, FAILED, ODD, PARTLY], next_cursor: null }),
    });
    renderApp(<SyncLog storeId={STORE} />);
    const table = await screen.findByRole("table");
    const [, pulled, failed, odd, partly] = within(table).getAllByRole("row");
    // done, with listings the marketplace refused
    expect(partly).toHaveTextContent("Berhasil");
    expect(partly).toHaveTextContent("1 listing ditolak: Stok di bawah cadangan promo.");

    expect(pulled).toHaveTextContent("Baca pesanan");
    expect(pulled).toHaveTextContent("Baca dari marketplace");
    expect(within(pulled!).getByText("Berhasil")).toBeInTheDocument();
    expect(pulled).toHaveTextContent("1 dtk");
    expect(failed).toHaveTextContent("Kirim stok");
    expect(failed).toHaveTextContent("Kirim ke marketplace");
    expect(within(failed!).getByText("Gagal")).toBeInTheDocument();
    expect(failed).toHaveTextContent("Shopee sedang sibuk. OmniSeller mencoba lagi otomatis.");
    expect(failed).toHaveTextContent("Percobaan ke-3");
    // work the screen does not know keeps its own name
    expect(odd).toHaveTextContent("orders.mystery");
    expect(within(odd!).getByText("Dilewati")).toBeInTheDocument();
  });

  it("shows the calls a job made on request", async () => {
    mockApi({ [`GET /v1/stores/${STORE}/sync-jobs`]: () => ({ items: [PULLED, FAILED], next_cursor: null }) });
    const user = userEvent.setup();
    renderApp(<SyncLog storeId={STORE} />);
    await user.click(await screen.findByRole("button", { name: "Lihat 1 panggilan" }));
    const list = screen.getByRole("list", { name: "Panggilan ke marketplace" });
    expect(list).toHaveTextContent("GET/api/v2/order/get_order_list?access_token=[redacted]200 · 310 ms");
    await user.click(screen.getByRole("button", { name: "Tutup panggilan" }));
    expect(screen.queryByRole("list", { name: "Panggilan ke marketplace" })).not.toBeInTheDocument();
    // a job without calls offers none
    expect(screen.getAllByRole("button", { name: /panggilan/ })).toHaveLength(1);
  });

  it("asks the api for failures only, through the URL", async () => {
    const calls = mockApi({
      [`GET /v1/stores/${STORE}/sync-jobs`]: (c) => ({
        items: c.query.status === "failed" ? [FAILED] : [PULLED, FAILED],
        next_cursor: null,
      }),
    });
    const user = userEvent.setup();
    renderApp(<SyncLog storeId={STORE} />);
    await screen.findByRole("table");
    expect(logCalls(calls)[0]?.query).toEqual({ limit: "50" });

    await user.click(screen.getByRole("radio", { name: "Gagal" }));
    expect(currentUrl()).toBe(`/integrasi/${STORE}?tab=log&status=failed`);
    await waitFor(() => expect(logCalls(calls).at(-1)?.query).toEqual({ limit: "50", status: "failed" }));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2));

    await user.click(screen.getByRole("radio", { name: "Semua" }));
    expect(currentUrl()).toBe(`/integrasi/${STORE}?tab=log`);
  });

  it("says when nothing failed, and loads older work with the cursor", async () => {
    setUrl(`/integrasi/${STORE}?tab=log&status=failed`);
    mockApi({ [`GET /v1/stores/${STORE}/sync-jobs`]: () => ({ items: [], next_cursor: null }) });
    const { unmount } = renderApp(<SyncLog storeId={STORE} />);
    expect(await screen.findByText("Tidak ada yang gagal.")).toBeInTheDocument();
    unmount();

    setUrl(`/integrasi/${STORE}?tab=log`);
    const calls = mockApi({
      [`GET /v1/stores/${STORE}/sync-jobs`]: (c) =>
        c.query.cursor === "C1" ? { items: [FAILED], next_cursor: null } : { items: [PULLED], next_cursor: "C1" },
    });
    const user = userEvent.setup();
    renderApp(<SyncLog storeId={STORE} />);
    await user.click(await screen.findByRole("button", { name: "Muat lebih banyak" }));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3));
    expect(logCalls(calls).at(-1)?.query).toEqual({ limit: "50", cursor: "C1" });
  });
});
