import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { mockApi, renderApp, testMe } from "@/test/render";
import {
  coverTone,
  dayCount,
  nextLimit,
  type RestockRow,
  restockExportHref,
  restockQuery,
  restockWorkbookHref,
} from "./restock-meta";
import { RestockView } from "./restock-view";

const JAKARTA = { id: "01JWAREHOUSE00000000000001", name: "Gudang Jakarta" };
const SURABAYA = { id: "01JWAREHOUSE00000000000002", name: "Gudang Surabaya" };

function row(over: Partial<RestockRow>): RestockRow {
  return {
    id: "01JVARIANT0000000000000001",
    sku: "KAOS-HTM-L",
    productName: "Kaos Polos",
    variantName: "Hitam, L",
    warehouseId: JAKARTA.id,
    warehouse: JAKARTA.name,
    available: 6,
    minStock: null,
    unitsSold: 60,
    dailyRate: 2,
    daysOfCover: 3,
    suggested: 54,
    reason: "low_cover",
    ...over,
  };
}

const rows = [
  row({
    id: "01JVARIANT0000000000000002",
    sku: "TMB-500",
    productName: "Tumbler",
    variantName: "",
    available: 0,
    daysOfCover: 0,
    suggested: 30,
    reason: "out",
  }),
  row({}),
  row({
    id: "01JVARIANT0000000000000003",
    sku: "KAOS-PTH-L",
    variantName: "Putih, L",
    available: 4,
    minStock: 5,
    unitsSold: 0,
    dailyRate: 0,
    daysOfCover: null,
    suggested: 2,
    reason: "below_min",
  }),
];

function api(list: (q: Record<string, string>) => unknown = () => ({ items: rows, total: 40, needed: 3 })) {
  return mockApi({
    "GET /v1/inventory/restock": (c) => list(c.query),
    "GET /v1/warehouses": () => ({ items: [JAKARTA, SURABAYA] }),
  });
}

const restockCalls = (calls: { path: string; query: Record<string, string> }[]) =>
  calls.filter((c) => c.path === "/v1/inventory/restock");

describe("restock rules", () => {
  it("reads day counts from the URL within 1 to 365 days", () => {
    expect(dayCount("21", 14)).toBe(21);
    expect(dayCount("0", 14)).toBe(14);
    expect(dayCount("366", 14)).toBe(14);
    expect(dayCount("2.5", 14)).toBe(14);
    expect(dayCount(null, 30)).toBe(30);
  });

  it("loads 200 more rows at a time, up to the api's 1,000", () => {
    expect(nextLimit(200)).toBe(400);
    expect(nextLimit(900)).toBe(1000);
    expect(nextLimit(1000)).toBe(1000);
  });

  it("colors the days left: red when empty, yellow under the warning days", () => {
    expect(coverTone({ available: 0, daysOfCover: 0 }, 14)).toBe("danger");
    expect(coverTone({ available: 5, daysOfCover: 13.9 }, 14)).toBe("warning");
    expect(coverTone({ available: 5, daysOfCover: 14 }, 14)).toBeNull();
    expect(coverTone({ available: 5, daysOfCover: null }, 14)).toBeNull();
  });

  it("sends only the filters in use, and the CSV gets all rows", () => {
    const query = restockQuery({ window: "7", coverDays: 14, targetDays: 30, warehouseId: null, q: "", all: false });
    expect(query).toEqual({ window: "7", coverDays: 14, targetDays: 30 });
    const full = restockQuery({ window: "30", coverDays: 7, targetDays: 60, warehouseId: "W1", q: "kaos", all: true });
    expect(new URL(restockExportHref(full), "http://x").search).toBe(
      "?window=30&coverDays=7&targetDays=60&warehouseId=W1&q=kaos&all=true",
    );
    expect(new URL(restockWorkbookHref(full), "http://x").search).toBe(
      "?window=30&coverDays=7&targetDays=60&warehouseId=W1&q=kaos&all=true&format=xlsx",
    );
  });
});

describe("RestockView (FR-STK-07)", () => {
  beforeEach(() => setUrl("/stok/restock"));

  it("lists what to order with the reason, days left, and the suggestion", async () => {
    const calls = api();
    renderApp(<RestockView />);

    const table = await screen.findByRole("table");
    const body = within(table).getAllByRole("row").slice(1);
    expect(body[0]).toHaveTextContent("TMB-500");
    expect(within(body[0] as HTMLElement).getAllByText("Habis").length).toBe(2); // days left and the reason
    expect(body[1]).toHaveTextContent("3 hari");
    expect(body[1]).toHaveTextContent("Segera habis");
    expect(body[1]).toHaveTextContent("54");
    expect(body[2]).toHaveTextContent("Belum terjual");
    expect(body[2]).toHaveTextContent("Di bawah minimum");
    // the SKU leads to its stock
    expect(within(body[1] as HTMLElement).getByRole("link", { name: "KAOS-HTM-L" })).toHaveAttribute(
      "href",
      "/stok?q=KAOS-HTM-L",
    );
    expect(screen.getByText("Menampilkan 3 dari 3")).toBeInTheDocument();
    expect(restockCalls(calls)[0]?.query).toEqual({ window: "30", coverDays: "14", targetDays: "30", limit: "200" });
    // "Unduh": the rows as Excel or as CSV, with the filters in use
    await userEvent.setup().click(screen.getByRole("button", { name: "Unduh" }));
    expect(await screen.findByRole("menuitem", { name: "Excel" })).toHaveAttribute(
      "href",
      "/v1/inventory/restock/export?window=30&coverDays=14&targetDays=30&format=xlsx",
    );
    expect(screen.getByRole("menuitem", { name: "CSV" })).toHaveAttribute(
      "href",
      "/v1/inventory/restock/export?window=30&coverDays=14&targetDays=30",
    );
  });

  it("changes the sales window, shows every row, and sets its own day counts", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<RestockView />);
    await screen.findByRole("table");

    await user.click(screen.getByText("7 hari"));
    expect(currentUrl()).toBe("/stok/restock?window=7");
    await waitFor(() => expect(restockCalls(calls).at(-1)?.query.window).toBe("7"));

    await user.click(screen.getByRole("button", { name: "Tampilkan semua" }));
    await waitFor(() => expect(restockCalls(calls).at(-1)?.query.all).toBe("true"));

    await user.click(screen.getByRole("button", { name: "Atur hitungan" }));
    const cover = screen.getByLabelText("Tandai bila stok cukup kurang dari (hari)");
    await user.clear(cover);
    await user.type(cover, "400");
    expect(screen.getByRole("alert")).toHaveTextContent("Isi angka bulat dari 1 sampai 365.");
    expect(screen.getByRole("button", { name: "Terapkan" })).toBeDisabled();
    await user.clear(cover);
    await user.type(cover, "21");
    await user.click(screen.getByRole("button", { name: "Terapkan" }));
    await waitFor(() => expect(restockCalls(calls).at(-1)?.query.coverDays).toBe("21"));
    expect(currentUrl()).toBe("/stok/restock?window=7&all=true&cover=21");
  });

  it("loads more rows until it has them all", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      row({ id: `01JVARIANT00000000000${String(i).padStart(5, "0")}`, sku: `SKU-${i}` }),
    );
    const calls = api((q) => ({ items: many.slice(0, Number(q.limit)), total: 900, needed: 250 }));
    const user = userEvent.setup();
    renderApp(<RestockView />);
    expect(await screen.findByText("Menampilkan 200 dari 250")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Muat lebih banyak" }));
    expect(await screen.findByText("Menampilkan 250 dari 250")).toBeInTheDocument();
    expect(restockCalls(calls).at(-1)?.query.limit).toBe("400");
    expect(screen.queryByRole("button", { name: "Muat lebih banyak" })).not.toBeInTheDocument();
  });

  it("says when nothing needs ordering", async () => {
    api(() => ({ items: [], total: 12, needed: 0 }));
    renderApp(<RestockView />);
    expect(await screen.findByText("Tidak ada yang perlu dipesan ulang")).toBeInTheDocument();
  });

  it("is closed to users who may not see stock", () => {
    const calls = api();
    renderApp(<RestockView />, { me: testMe(["order:read"]) });
    expect(
      screen.getByText("Halaman ini hanya bisa dibuka pengguna yang punya izin melihat stok."),
    ).toBeInTheDocument();
    expect(restockCalls(calls)).toHaveLength(0);
  });
});
