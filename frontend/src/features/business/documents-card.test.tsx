import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type ApiCall, mockApi, renderApp } from "@/test/render";
import { DocumentsCard } from "./documents-card";
import { doc, PROFILE } from "./fixtures";

const posted = (calls: ApiCall[]) => calls.filter((c) => c.method === "POST" && c.path === "/v1/business-documents");
const pdf = (name = "sppkp.pdf", size = 9) =>
  new File([new Uint8Array(size).fill(0x25)], name, { type: "application/pdf" });

describe("Dokumen legalitas", () => {
  it("uploads a document with its number and validity, after checking what is missing", async () => {
    const calls = mockApi({
      "POST /v1/business-documents": () =>
        Response.json(doc({ id: "01JDOC0000000000000000009", kind: "sppkp", title: "SPPKP" }), { status: 201 }),
      "GET /v1/business-profile": () => PROFILE,
    });
    const user = userEvent.setup();
    renderApp(<DocumentsCard profile={PROFILE} />);
    expect(screen.getByText(/Belum ada dokumen/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unggah dokumen" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Unggah dokumen" }));
    expect(within(dialog).getByText("Isi tanggal berlaku, atau centang berlaku seterusnya.")).toBeInTheDocument();
    expect(within(dialog).getByText("Pilih berkas dokumennya.")).toBeInTheDocument();
    expect(posted(calls)).toHaveLength(0);

    await user.click(within(dialog).getByRole("combobox", { name: "Jenis dokumen" }));
    await user.click(await screen.findByRole("option", { name: "SPPKP" }));
    await user.type(within(dialog).getByLabelText("Nomor dokumen"), "S-123/PKP/2024");
    await user.type(within(dialog).getByLabelText("Tanggal terbit"), "2024-03-01");
    await user.type(within(dialog).getByLabelText("Berlaku sampai"), "2029-03-01");
    await user.upload(within(dialog).getByLabelText("Berkas"), pdf());
    await user.click(within(dialog).getByRole("button", { name: "Unggah dokumen" }));

    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0]!.body).toEqual({
      kind: "sppkp",
      number: "S-123/PKP/2024",
      issuedOn: "2024-03-01",
      validUntil: "2029-03-01",
      fileName: "sppkp.pdf",
      content: "JSUlJSUlJSUl",
    });
    expect(await screen.findByText("SPPKP diunggah.")).toBeInTheDocument();
  });

  it("keeps a document valid forever, asks a name for another kind, and refuses big files", async () => {
    const calls = mockApi({
      "POST /v1/business-documents": () =>
        Response.json(doc({ kind: "other", title: "Sertifikat halal" }), { status: 201 }),
      "GET /v1/business-profile": () => PROFILE,
    });
    const user = userEvent.setup();
    renderApp(<DocumentsCard profile={PROFILE} />);
    await user.click(screen.getByRole("button", { name: "Unggah dokumen" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Jenis dokumen" }));
    await user.click(await screen.findByRole("option", { name: "Dokumen lain" }));
    await user.click(within(dialog).getByLabelText("Berlaku seterusnya"));
    expect(within(dialog).getByLabelText("Berlaku sampai")).toBeDisabled();
    await user.upload(within(dialog).getByLabelText("Berkas"), pdf("besar.pdf", 5_000_001));
    await user.click(within(dialog).getByRole("button", { name: "Unggah dokumen" }));
    expect(within(dialog).getByText("Isi nama dokumennya.")).toBeInTheDocument();
    expect(within(dialog).getByText("Berkas berupa PDF, JPG, atau PNG, paling besar 5 MB.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Nama dokumen"), "Sertifikat halal");
    await user.upload(within(dialog).getByLabelText("Berkas"), pdf("halal.pdf"));
    await user.click(within(dialog).getByRole("button", { name: "Unggah dokumen" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect(posted(calls)[0]!.body).toMatchObject({ kind: "other", title: "Sertifikat halal", validUntil: null });
  });

  it("renews a document by its new end date, and removes one after asking", async () => {
    const nib = doc();
    const sppkp = doc({
      id: "01JDOC0000000000000000002",
      kind: "sppkp",
      title: "SPPKP",
      number: null,
      issuedOn: "2024-03-01",
      validUntil: "2026-10-20",
      status: "expiring",
      daysLeft: 13,
    });
    const calls = mockApi({
      [`PATCH /v1/business-documents/${sppkp.id}`]: (c) => ({ ...sppkp, ...(c.body as object) }),
      [`DELETE /v1/business-documents/${nib.id}`]: () => new Response(null, { status: 204 }),
      "GET /v1/business-profile": () => PROFILE,
    });
    const user = userEvent.setup();
    renderApp(<DocumentsCard profile={{ ...PROFILE, documents: [nib, sppkp] }} />);

    await user.click(screen.getByRole("button", { name: "Ubah SPPKP" }));
    const edit = await screen.findByRole("dialog");
    const until = within(edit).getByLabelText("Berlaku sampai");
    expect(until).toHaveValue("20/10/2026");
    await user.clear(until);
    await user.type(until, "2031-10-20");
    await user.click(within(edit).getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      title: "SPPKP",
      number: null,
      issuedOn: "2024-03-01",
      validUntil: "2031-10-20",
    });
    expect(await screen.findByText("SPPKP disimpan.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hapus NIB" }));
    const ask = await screen.findByRole("dialog", { name: "Hapus NIB?" });
    expect(ask).toHaveTextContent("Berkasnya ikut dihapus dan tidak bisa dikembalikan.");
    await user.click(within(ask).getByRole("button", { name: "Hapus dokumen" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText("NIB dihapus.")).toBeInTheDocument();
  });
});
