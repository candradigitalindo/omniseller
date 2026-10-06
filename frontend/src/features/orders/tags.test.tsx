import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { type ApiCall, mockApi, problem, renderApp } from "@/test/render";
import { TAG_COLORS } from "./tag-meta";
import { TagPicker, TagsDialog } from "./tags";

const PRIORITAS = { id: "01JTAG00000000000000000001", name: "Prioritas", color: "#E34948" };
const GROSIR = { id: "01JTAG00000000000000000002", name: "Grosir", color: "#2A78D6" };
const PECAH = { id: "01JTAG00000000000000000003", name: "Mudah pecah", color: null };
const ORDERS = [
  { id: "01JORDER000000000000000001", tags: [PRIORITAS, GROSIR] },
  { id: "01JORDER000000000000000002", tags: [PRIORITAS] },
];

function api(extra: Record<string, (c: ApiCall) => unknown> = {}) {
  // tags made in a test are listed afterwards, as the api would
  const made: { id: string; name: string; color: string | null; orders: number }[] = [];
  return mockApi({
    "GET /v1/tags": () => ({
      items: [{ ...GROSIR, orders: 4 }, { ...PECAH, orders: 0 }, { ...PRIORITAS, orders: 2 }, ...made].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }),
    "POST /v1/tags": (c) => {
      const tag = {
        id: "01JTAG00000000000000000009",
        orders: 0,
        ...(c.body as { name: string; color: string | null }),
      };
      made.push(tag);
      return Response.json(tag, { status: 201 });
    },
    "POST /v1/orders/tags": (c) => ({
      items: (c.body as { orderIds: string[] }).orderIds.map((orderId) => ({ orderId, tags: [] })),
    }),
    ...extra,
  });
}

async function openPicker() {
  const user = userEvent.setup();
  renderApp(<TagPicker orders={ORDERS} trigger={<Button>Beri tag</Button>} />);
  await user.click(screen.getByRole("button", { name: "Beri tag" }));
  const list = await screen.findByRole("list", { name: "Daftar tag" });
  await within(list).findByText("Prioritas");
  const box = (name: string) => within(list).getByRole("checkbox", { name });
  return { user, list, box };
}

const sent = (calls: ApiCall[], path: string) => calls.filter((c) => c.method !== "GET" && c.path === path);

describe("Beri tag", () => {
  it("shows which tags all, some, or none of the orders carry, and sends only what changed", async () => {
    const calls = api();
    const { user, box } = await openPicker();
    expect(screen.getByText("Tag untuk 2 pesanan")).toBeInTheDocument();
    expect(box("Prioritas")).toHaveAttribute("aria-checked", "true");
    expect(box("Grosir")).toHaveAttribute("aria-checked", "mixed");
    expect(box("Mudah pecah")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Terapkan" })).toBeDisabled();

    await user.click(box("Mudah pecah"));
    await user.click(box("Prioritas"));
    await user.click(screen.getByRole("button", { name: "Terapkan" }));

    await waitFor(() => expect(sent(calls, "/v1/orders/tags")).toHaveLength(1));
    expect(sent(calls, "/v1/orders/tags")[0]?.body).toEqual({
      orderIds: ORDERS.map((o) => o.id),
      add: [PECAH.id],
      remove: [PRIORITAS.id],
    });
    expect(await screen.findByText("Tag diperbarui pada 2 pesanan.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Daftar tag" })).not.toBeInTheDocument();
  });

  it("puts a tag that some orders carry on all, off all, then back as it was", async () => {
    api();
    const { user, box } = await openPicker();
    await user.click(box("Grosir"));
    expect(box("Grosir")).toHaveAttribute("aria-checked", "true");
    await user.click(box("Grosir"));
    expect(box("Grosir")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Terapkan" })).toBeEnabled();
    await user.click(box("Grosir"));
    expect(box("Grosir")).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByRole("button", { name: "Terapkan" })).toBeDisabled();
  });

  it("finds a tag by part of its name and makes a new one from what was typed", async () => {
    const calls = api();
    const { user, list, box } = await openPicker();
    const search = screen.getByRole("textbox", { name: "Cari atau buat tag" });

    await user.type(search, "PRIO");
    expect(within(list).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(list).getByRole("button", { name: "Buat tag “PRIO”" })).toBeInTheDocument();
    // a name another tag already has, in any case, is not offered again
    await user.clear(search);
    await user.type(search, "prioritas");
    expect(within(list).queryByRole("button", { name: /Buat tag/ })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, " Reseller Bandung {Enter}");
    await waitFor(() => expect(sent(calls, "/v1/tags")).toHaveLength(1));
    // the fourth tag takes the fourth color of the palette
    expect(sent(calls, "/v1/tags")[0]?.body).toEqual({ name: "Reseller Bandung", color: TAG_COLORS[3].hex });
    expect(await within(list).findByRole("checkbox", { name: "Reseller Bandung" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(search).toHaveValue("");

    await user.click(box("Mudah pecah"));
    await user.click(screen.getByRole("button", { name: "Terapkan" }));
    await waitFor(() => expect(sent(calls, "/v1/orders/tags")).toHaveLength(1));
    const body = sent(calls, "/v1/orders/tags")[0]?.body as { add: string[]; remove: string[] };
    expect([...body.add].sort()).toEqual(["01JTAG00000000000000000009", PECAH.id].sort());
    expect(body.remove).toEqual([]);
  });

  it("makes a tag by clicking the offer under the list", async () => {
    const calls = api();
    const { user, list } = await openPicker();
    await user.type(screen.getByRole("textbox", { name: "Cari atau buat tag" }), "COD");
    await user.click(within(list).getByRole("button", { name: "Buat tag “COD”" }));
    await waitFor(() => expect(sent(calls, "/v1/tags")).toHaveLength(1));
  });
});

describe("Kelola tag", () => {
  async function openManager() {
    const user = userEvent.setup();
    renderApp(<TagsDialog open onClose={() => {}} />);
    const list = await screen.findByRole("list", { name: "Daftar tag" });
    await within(list).findByText("Prioritas");
    return { user, list };
  }

  it("lists the tags with how many orders carry each", async () => {
    api();
    const { list } = await openManager();
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Grosir4 pesanan"),
      expect.stringContaining("Mudah pecahBelum dipakai"),
      expect.stringContaining("Prioritas2 pesanan"),
    ]);
  });

  it("makes a new tag with a chosen color, refusing a name already used", async () => {
    const calls = api();
    const { user } = await openManager();
    await user.click(screen.getByRole("button", { name: "Tambah tag" }));
    const name = screen.getByLabelText("Nama tag");
    await user.type(name, "grosir");
    await user.click(screen.getByRole("button", { name: "Tambah" }));
    expect(await screen.findByText("Sudah ada tag dengan nama ini.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(sent(calls, "/v1/tags")).toHaveLength(0);

    await user.clear(name);
    expect(screen.queryByText("Sudah ada tag dengan nama ini.")).not.toBeInTheDocument();
    await user.type(name, "Grosir besar");
    await user.click(screen.getByRole("radio", { name: "Ungu" }));
    await user.click(screen.getByRole("button", { name: "Tambah" }));
    await waitFor(() => expect(sent(calls, "/v1/tags")).toHaveLength(1));
    expect(sent(calls, "/v1/tags")[0]?.body).toEqual({ name: "Grosir besar", color: "#4A3AA7" });
    expect(await screen.findByText("Tag Grosir besar dibuat.")).toBeInTheDocument();
  });

  it("saves only what changed of a tag, and shows the api's refusal under the name", async () => {
    let refuse = false;
    const calls = api({
      [`PATCH /v1/tags/${PRIORITAS.id}`]: (c) =>
        refuse
          ? problem(409, "tag.duplicate", "Sudah ada tag dengan nama ini.")
          : { ...PRIORITAS, ...(c.body as object), orders: 2 },
    });
    const { user } = await openManager();
    await user.click(screen.getByRole("button", { name: "Ubah tag Prioritas" }));
    await user.click(screen.getByRole("radio", { name: "Tanpa warna" }));
    await user.click(screen.getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(sent(calls, `/v1/tags/${PRIORITAS.id}`)).toHaveLength(1));
    expect(sent(calls, `/v1/tags/${PRIORITAS.id}`)[0]?.body).toEqual({ color: null });

    refuse = true;
    await user.click(await screen.findByRole("button", { name: "Ubah tag Prioritas" }));
    const name = screen.getByLabelText("Nama tag");
    await user.clear(name);
    await user.type(name, "Kilat");
    await user.click(screen.getByRole("button", { name: "Simpan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sudah ada tag dengan nama ini.");
    expect(sent(calls, `/v1/tags/${PRIORITAS.id}`)[1]?.body).toEqual({ name: "Kilat" });
  });

  it("closes the form without asking the api when nothing changed", async () => {
    const calls = api();
    const { user } = await openManager();
    await user.click(screen.getByRole("button", { name: "Ubah tag Grosir" }));
    await user.click(screen.getByRole("button", { name: "Simpan" }));
    expect(await screen.findByRole("button", { name: "Ubah tag Grosir" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("asks before deleting a tag, saying how many orders lose it", async () => {
    const calls = api({ [`DELETE /v1/tags/${GROSIR.id}`]: () => undefined });
    const { user } = await openManager();
    await user.click(screen.getByRole("button", { name: "Hapus tag Grosir" }));
    expect(screen.getByText("Hapus tag Grosir? Tag dilepas dari 4 pesanan.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Hapus tag Mudah pecah" }));
    expect(screen.getByText("Hapus tag Mudah pecah?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hapus tag Grosir" }));
    expect(screen.queryByText("Hapus tag Mudah pecah?")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hapus tag" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1));
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(`/v1/tags/${GROSIR.id}`);
    expect(await screen.findByText("Tag Grosir dihapus.")).toBeInTheDocument();
  });
});
