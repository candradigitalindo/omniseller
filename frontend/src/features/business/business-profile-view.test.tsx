import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type ApiCall, mockApi, problem, renderApp, testMe } from "@/test/render";
import { BusinessProfileView } from "./business-profile-view";
import { doc, PROFILE } from "./fixtures";

const patches = (calls: ApiCall[]) => calls.filter((c) => c.method === "PATCH" && c.path === "/v1/business-profile");

describe("Profil Bisnis & Legalitas", () => {
  it("asks for an NIB, and saves only what changed with the version it read", async () => {
    const calls = mockApi({
      "GET /v1/business-profile": () => PROFILE,
      "PATCH /v1/business-profile": (c) => ({
        ...PROFILE,
        rowVersion: 4,
        name: "Toko Rina Jaya",
        nib: "1234567890123",
        nibStatus: "registered",
        ...(c.body as object),
      }),
    });
    const user = userEvent.setup();
    renderApp(<BusinessProfileView />);
    expect(
      await screen.findByText(/NIB wajib bagi penjual di marketplace menurut Permendag 19\/2026/),
    ).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Simpan perubahan" });
    expect(save).toBeDisabled();

    const name = screen.getByLabelText("Nama bisnis");
    await user.clear(name);
    await user.type(name, "Toko Rina Jaya");
    await user.click(screen.getByText("Sudah punya"));
    await user.type(screen.getByLabelText("Nomor NIB"), "1234 5678 90123");
    expect(screen.getByText("Ada perubahan yang belum disimpan.")).toBeInTheDocument();
    await user.click(save);

    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.body).toEqual({ name: "Toko Rina Jaya", nib: "1234567890123", nibInProcessSince: null });
    expect(patches(calls)[0]!.headers?.["if-match"]).toBe('"3"');
    expect(await screen.findByText("Profil bisnis disimpan.")).toBeInTheDocument();
    // registered: no banner any more, and the form shows what was saved, as it is printed
    await waitFor(() => expect(screen.queryByText(/NIB wajib bagi penjual/)).not.toBeInTheDocument());
    expect(screen.getByLabelText("Nomor NIB")).toHaveValue("1234567890123");
    expect(screen.queryByText("Ada perubahan yang belum disimpan.")).not.toBeInTheDocument();
  });

  it("checks numbers before asking the api, and shows the api's word on its field", async () => {
    const calls = mockApi({
      "GET /v1/business-profile": () => PROFILE,
      "PATCH /v1/business-profile": () =>
        problem(422, "validation.failed", "Periksa kembali isian yang ditandai.", {
          errors: [{ path: "npwp", message: "NPWP terdiri dari 15 atau 16 angka." }],
        }),
    });
    const user = userEvent.setup();
    renderApp(<BusinessProfileView />);
    const npwp = await screen.findByLabelText("NPWP");
    await user.clear(npwp);
    await user.type(npwp, "1234");
    expect(screen.getByText("NPWP terdiri dari 15 atau 16 angka.")).toBeInTheDocument();
    expect(npwp).toHaveAttribute("aria-invalid", "true");
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    expect(patches(calls)).toHaveLength(0);

    // a number the browser accepts but the api refuses
    await user.clear(npwp);
    await user.type(npwp, "123456789012345");
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(await screen.findAllByText("NPWP terdiri dari 15 atau 16 angka.")).not.toHaveLength(0);
  });

  it("counts down an NIB in process, and says when its six months are over", async () => {
    mockApi({
      "GET /v1/business-profile": () => ({
        ...PROFILE,
        nibStatus: "in_process",
        nibInProcessSince: "2026-04-20",
        nibDeadline: "2026-10-20",
        nibDaysLeft: 13,
      }),
    });
    const { unmount } = renderApp(<BusinessProfileView />);
    expect(
      await screen.findByText(/NIB sedang diurus sejak 20 Apr 2026\. Batasnya 20 Okt 2026 \(13 hari lagi\)/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Mulai diurus sejak")).toHaveValue("2026-04-20");
    unmount();
    mockApi({
      "GET /v1/business-profile": () => ({
        ...PROFILE,
        nibStatus: "in_process",
        nibInProcessSince: "2026-03-01",
        nibDeadline: "2026-09-01",
        nibDaysLeft: -36,
      }),
    });
    renderApp(<BusinessProfileView />);
    expect(await screen.findByText(/Batas 6 bulan proses NIB sudah lewat \(1 Sep 2026\)/)).toBeInTheDocument();
  });

  it("keeps unsaved typing when the logo changes", async () => {
    mockApi({
      "GET /v1/business-profile": () => PROFILE,
      "PUT /v1/business-profile/logo": () => ({ ...PROFILE, rowVersion: 4, hasLogo: true }),
    });
    const user = userEvent.setup();
    const { container } = renderApp(<BusinessProfileView />);
    const name = await screen.findByLabelText("Nama bisnis");
    await user.clear(name);
    await user.type(name, "Toko Rina Baru");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([0x89, 0x50])], "logo.png", { type: "image/png" }));
    expect(await screen.findByRole("img", { name: "Logo Toko Rina" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nama bisnis")).toHaveValue("Toko Rina Baru");
  });

  it("uploads a logo and removes it", async () => {
    const calls = mockApi({
      "GET /v1/business-profile": () => PROFILE,
      "PUT /v1/business-profile/logo": () => ({ ...PROFILE, rowVersion: 4, hasLogo: true }),
      "DELETE /v1/business-profile/logo": () => ({ ...PROFILE, rowVersion: 5, hasLogo: false }),
    });
    const user = userEvent.setup({ applyAccept: false });
    const { container } = renderApp(<BusinessProfileView />);
    await screen.findByRole("button", { name: "Unggah logo" });
    const input = container.querySelector(
      'input[type="file"][accept="image/png,image/jpeg,image/webp"]',
    ) as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ content: "iVBORw==" });
    expect(await screen.findByRole("img", { name: "Logo Toko Rina" })).toHaveAttribute(
      "src",
      "/v1/business-profile/logo?v=4",
    );
    // a file that is not an image is refused here
    await user.upload(input, new File(["%PDF"], "logo.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("Logo berupa PNG, JPG, atau WebP, paling besar 1 MB.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Hapus logo" }));
    await waitFor(() => expect(screen.queryByRole("img", { name: "Logo Toko Rina" })).not.toBeInTheDocument());
  });

  it("lists documents with how long they are valid", async () => {
    mockApi({
      "GET /v1/business-profile": () => ({
        ...PROFILE,
        documents: [
          doc(),
          doc({
            id: "01JDOC0000000000000000002",
            kind: "sppkp",
            title: "Surat Pengukuhan PKP",
            number: null,
            issuedOn: null,
            validUntil: "2026-10-27",
            status: "expiring",
            daysLeft: 20,
            fileName: "sppkp.png",
          }),
          doc({
            id: "01JDOC0000000000000000003",
            kind: "business_license",
            title: "Izin usaha",
            validUntil: "2026-10-01",
            status: "expired",
            daysLeft: -6,
          }),
        ],
      }),
    });
    renderApp(<BusinessProfileView />);
    const list = await screen.findByRole("list", { name: "Dokumen legalitas" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Berlaku seterusnya"),
      expect.stringContaining("Habis dalam 20 hari"),
      expect.stringContaining("Habis berlaku 1 Okt 2026"),
    ]);
    // a title of its own also says what kind of document it is
    expect(rows[1]).toHaveTextContent("Surat Pengukuhan PKP · SPPKP");
    expect(rows[0]).toHaveTextContent("No. 1234567890123 · Terbit 10 Jan 2024 · nib.pdf");
    expect(within(rows[0]!).getByRole("link", { name: "Lihat NIB" })).toHaveAttribute(
      "href",
      "/v1/business-documents/01JDOC0000000000000000001/file",
    );
  });

  it("is only for the owner of the business", () => {
    const calls = mockApi({});
    renderApp(<BusinessProfileView />, { me: testMe(["settings:user", "audit:read"]) });
    expect(screen.getByText("Hanya pemilik bisnis yang bisa membuka profil bisnis dan legalitas.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
