import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/navigation";
import { type ApiCall, mockApi, problem, renderApp, testMe } from "@/test/render";
import { CourierHoursView } from "./courier-hours-view";

const W1 = "01JWAREHOUSE00000000000001";
const W2 = "01JWAREHOUSE00000000000002";
const JNT = {
  id: "01JCUTOFF00000000000000001",
  warehouseId: W1,
  courier: "J&T Express",
  cutoffTime: "15:00",
  days: [1, 2, 3, 4, 5, 6],
  active: true,
  rowVersion: 3,
};
const JNE = {
  ...JNT,
  id: "01JCUTOFF00000000000000002",
  courier: "JNE",
  cutoffTime: "14:00",
  days: [1, 3, 5],
  active: false,
};
const WAREHOUSES = {
  items: [
    { id: W1, name: "Gudang Jakarta", code: "JKT" },
    { id: W2, name: "Gudang Surabaya", code: "SBY" },
  ],
  next_cursor: null,
};
const posted = (calls: ApiCall[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("Kurir & Jam Operasional (L43)", () => {
  beforeEach(() => setUrl("/kurir-jam"));

  it("lists cut-offs per warehouse, and adds one after checking what is missing", async () => {
    const calls = mockApi({
      "GET /v1/courier-cutoffs": () => ({ items: [JNT, JNE], next_cursor: null }),
      "GET /v1/warehouses": () => WAREHOUSES,
      "GET /v1/orders/couriers": () => ({ items: [{ courier: "J&T Express", orders: 12 }], next_cursor: null }),
      "POST /v1/courier-cutoffs": (c) => ({ ...JNT, id: "01JCUTOFF00000000000000003", ...(c.body as object) }),
    });
    const user = userEvent.setup();
    renderApp(<CourierHoursView />);
    const jakarta = await screen.findByRole("list", { name: "Cut-off Gudang Jakarta" });
    const rows = within(jakarta).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("J&T ExpressPickup terakhir 15.00 · Sen–SabAktif");
    expect(rows[1]).toHaveTextContent("JNEPickup terakhir 14.00 · Sen, Rab, JumNonaktif");
    expect(screen.queryByRole("list", { name: "Cut-off Gudang Surabaya" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tambah cut-off" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah cut-off kurir" });
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(within(dialog).getByText("Pilih gudang.")).toBeInTheDocument();
    expect(within(dialog).getByText("Isi nama kurir.")).toBeInTheDocument();
    expect(posted(calls, "/v1/courier-cutoffs")).toHaveLength(0);

    await user.click(within(dialog).getByRole("combobox", { name: "Gudang" }));
    await user.click(await screen.findByRole("option", { name: "Gudang Surabaya" }));
    await user.type(within(dialog).getByLabelText("Kurir"), "J&T Express");
    // the couriers the orders went with are offered
    await waitFor(() => expect(document.querySelector('#cutoff-couriers option[value="J&T Express"]')).not.toBeNull());
    fireEvent.change(within(dialog).getByLabelText("Jam cut-off"), { target: { value: "16:00" } });
    await user.click(within(dialog).getByLabelText("Sab"));
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(posted(calls, "/v1/courier-cutoffs")).toHaveLength(1));
    expect(posted(calls, "/v1/courier-cutoffs")[0]!.body).toEqual({
      warehouseId: W2,
      courier: "J&T Express",
      cutoffTime: "16:00",
      days: [1, 2, 3, 4, 5],
    });
    expect(await screen.findByText("Cut-off J&T Express disimpan.")).toBeInTheDocument();
  });

  it("says when the warehouse already has that courier", async () => {
    mockApi({
      "GET /v1/courier-cutoffs": () => ({ items: [], next_cursor: null }),
      "GET /v1/warehouses": () => ({ items: [WAREHOUSES.items[0]], next_cursor: null }),
      "POST /v1/courier-cutoffs": () =>
        problem(409, "courier_cutoff.duplicate", "Gudang ini sudah punya cut-off untuk kurir itu. Ubah yang ada saja."),
    });
    const user = userEvent.setup();
    renderApp(<CourierHoursView />, { me: testMe(["settings:warehouse"]) });
    expect(await screen.findByText("Belum ada cut-off kurir")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Tambah cut-off" })[0]!);
    const dialog = await screen.findByRole("dialog");
    // one warehouse: chosen already; without order:read no suggestions are asked for
    await user.type(within(dialog).getByLabelText("Kurir"), "JNE");
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("sudah punya cut-off untuk kurir itu");
  });

  it("switches a cut-off off with the version it read, and removes one after asking", async () => {
    const calls = mockApi({
      "GET /v1/courier-cutoffs": () => ({ items: [JNT], next_cursor: null }),
      "GET /v1/warehouses": () => WAREHOUSES,
      [`PATCH /v1/courier-cutoffs/${JNT.id}`]: (c) => ({ ...JNT, ...(c.body as object), rowVersion: 4 }),
      [`DELETE /v1/courier-cutoffs/${JNT.id}`]: () => undefined,
    });
    const user = userEvent.setup();
    renderApp(<CourierHoursView />);
    await user.click(await screen.findByRole("switch", { name: "Cut-off J&T Express aktif" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ active: false });
    expect(patch.headers?.["if-match"]).toBe('"3"');

    await user.click(screen.getByRole("button", { name: "Hapus J&T Express" }));
    const ask = await screen.findByRole("dialog", { name: "Hapus cut-off J&T Express?" });
    await user.click(within(ask).getByRole("button", { name: "Hapus" }));
    expect(await screen.findByText("Cut-off J&T Express dihapus.")).toBeInTheDocument();
  });

  it("keeps courier holidays for every courier or one", async () => {
    setUrl("/kurir-jam?tab=libur");
    const calls = mockApi({
      "GET /v1/courier-holidays": () => ({
        items: [{ id: "01JHOLIDAY0000000000000001", date: "2026-12-25", courier: null, note: "Natal" }],
        next_cursor: null,
      }),
      "POST /v1/courier-holidays": (c) => ({ id: "01JHOLIDAY0000000000000002", note: null, ...(c.body as object) }),
    });
    const user = userEvent.setup();
    renderApp(<CourierHoursView />);
    const list = await screen.findByRole("list", { name: "Hari libur kurir" });
    expect(list).toHaveTextContent("Jumat, 25 Des 2026Semua kurir · Natal");

    await user.click(screen.getByRole("button", { name: "Tambah hari libur" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah hari libur kurir" });
    await user.click(within(dialog).getByText("Satu kurir"));
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(within(dialog).getByText("Pilih tanggal.")).toBeInTheDocument();
    expect(within(dialog).getByText("Isi nama kurir.")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Tanggal"), { target: { value: "2026-12-26" } });
    await user.type(within(dialog).getByLabelText("Kurir"), "JNE");
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(posted(calls, "/v1/courier-holidays")).toHaveLength(1));
    expect(posted(calls, "/v1/courier-holidays")[0]!.body).toEqual({ date: "2026-12-26", courier: "JNE", note: null });
  });

  it("sets the usual week from a ready one, refuses a day that closes before it opens, and adds a special period", async () => {
    setUrl("/kurir-jam?tab=jam");
    const calls = mockApi({
      "GET /v1/operating-hours": () => ({ week: null, periods: [] }),
      "PUT /v1/operating-hours/week": (c) => ({
        id: "01JHOURS000000000000000001",
        schedule: (c.body as { schedule: unknown }).schedule,
        rowVersion: 1,
      }),
      "POST /v1/operating-hours/periods": () =>
        problem(409, "operating_hours.overlap", 'Tanggalnya bertabrakan dengan periode "Ramadan".'),
    });
    const user = userEvent.setup();
    renderApp(<CourierHoursView />);
    expect(await screen.findByText(/Belum diatur/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Atur jam operasional" }));
    expect(screen.getByRole("switch", { name: "Minggu buka" })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Jam tutup Rabu"), { target: { value: "07:00" } });
    await user.click(screen.getByRole("button", { name: "Simpan jam operasional" }));
    expect(await screen.findByText("Jam tutup Rabu harus setelah jam buka.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    fireEvent.change(screen.getByLabelText("Jam tutup Rabu"), { target: { value: "16:00" } });
    await user.click(screen.getByRole("switch", { name: "Minggu buka" }));
    await user.click(screen.getByRole("button", { name: "Simpan jam operasional" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const week = (calls.find((c) => c.method === "PUT")!.body as { schedule: unknown[] }).schedule;
    expect(week[0]).toEqual({ open: "08:00", close: "17:00" });
    expect(week[3]).toEqual({ open: "08:00", close: "16:00" });
    expect(week[6]).toEqual({ open: "08:00", close: "14:00" });

    await user.click(screen.getByRole("button", { name: "Tambah periode" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah periode khusus" });
    await user.type(within(dialog).getByLabelText("Nama periode"), "Lebaran");
    fireEvent.change(within(dialog).getByLabelText("Mulai"), { target: { value: "2027-03-09" } });
    fireEvent.change(within(dialog).getByLabelText("Sampai"), { target: { value: "2027-03-08" } });
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(within(dialog).getByText("Tanggal sampai tidak boleh sebelum tanggal mulai.")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Sampai"), { target: { value: "2027-03-12" } });
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("bertabrakan dengan periode");
    expect(posted(calls, "/v1/operating-hours/periods")[0]!.body).toMatchObject({
      name: "Lebaran",
      from: "2027-03-09",
      to: "2027-03-12",
    });
  });

  it("is only for whoever manages the warehouses", () => {
    const calls = mockApi({});
    renderApp(<CourierHoursView />, { me: testMe(["order:read"]) });
    expect(screen.getByText(/Hanya pengelola gudang/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
