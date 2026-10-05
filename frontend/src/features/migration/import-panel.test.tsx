import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { mockApi, renderApp } from "@/test/render";
import type { ImportJob } from "./migration-meta";
import { MigrationView } from "./migration-view";

const JOB = "01JIMPORT00000000000000001";
const FIELDS = {
  fields: [
    { key: "product_name", label: "Nama produk", required: true, unit: null },
    { key: "sku", label: "SKU varian", required: true, unit: null },
    { key: "price", label: "Harga jual", required: true, unit: null },
    { key: "weight", label: "Berat", required: true, unit: "weight" },
    { key: "cost", label: "HPP", required: false, unit: null },
  ],
  sourceApps: [
    { key: "bigseller", name: "BigSeller" },
    { key: "ginee", name: "Ginee" },
    { key: "spreadsheet", name: "Spreadsheet" },
  ],
};

function job(over: Partial<ImportJob> = {}): ImportJob {
  return {
    id: JOB,
    sourceApp: "bigseller",
    sourceAppName: "BigSeller",
    status: "uploaded",
    fileName: "ekspor-bigseller.xlsx",
    fileType: "xlsx",
    fileAvailable: true,
    columns: ["Nama Produk", "SKU", "Harga Jual", "Berat (kg)", "Harga Modal"],
    preview: [
      ["Kaos Polos Hitam L", "KAOS-HTM-L", "65.000", "0,25", "35.000"],
      ["Kaos Polos Putih L", "KAOS-PTH-L", "65.000", "0,25", "35.000"],
    ],
    mapping: { headerRow: 1, fields: { product_name: 0, sku: 1, weight: 3 }, weightUnit: "kg", dimensionUnit: "cm" },
    stats: { rows: 2 },
    error: null,
    createdBy: null,
    createdAt: "2026-10-06T01:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

function api(current: () => ImportJob = () => job()) {
  return mockApi({
    "GET /v1/migration/fields": () => FIELDS,
    "GET /v1/migration/presets": () => ({ items: [] }),
    "GET /v1/migration/imports": () => ({ items: [job({ status: "imported" })] }),
    "POST /v1/migration/imports": () => job(),
    [`GET /v1/migration/imports/${JOB}`]: () => current(),
    [`PUT /v1/migration/imports/${JOB}/mapping`]: () => job(),
    [`POST /v1/migration/imports/${JOB}/validate`]: () => job({ status: "validating" }),
    [`POST /v1/migration/imports/${JOB}/import`]: () => job({ status: "importing" }),
    [`GET /v1/migration/imports/${JOB}/errors`]: () => ({
      items: [
        {
          id: "E1",
          rowNumber: 3,
          field: "price",
          fieldLabel: "Harga jual",
          message: "Harga harus angka rupiah bulat.",
          raw: [],
        },
      ],
      nextCursor: null,
    }),
  });
}

describe("import products (L46 steps 1 to 3)", () => {
  beforeEach(() => setUrl("/migrasi"));

  it("uploads an export of the chosen app as base64 and opens it", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    expect(await screen.findByText("Impor sebelumnya")).toBeInTheDocument();
    await user.click(await screen.findByText("BigSeller"));
    await user.upload(
      screen.getByLabelText("Berkas ekspor"),
      new File(["a;b\n1;2"], "ekspor.csv", { type: "text/csv" }),
    );
    await user.click(screen.getByRole("button", { name: "Unggah dan petakan kolom" }));
    await waitFor(() => expect(currentUrl()).toBe(`/migrasi?job=${JOB}`));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      sourceApp: "bigseller",
      fileName: "ekspor.csv",
      content: Buffer.from("a;b\n1;2").toString("base64"),
    });
  });

  it("refuses a file over 8 MB before sending it", async () => {
    api();
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    await user.click(await screen.findByText("Ginee"));
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "besar.xlsx");
    await user.upload(screen.getByLabelText("Berkas ekspor"), big);
    expect(screen.getByRole("alert")).toHaveTextContent("Berkas lebih dari 8 MB.");
    expect(screen.getByRole("button", { name: "Unggah dan petakan kolom" })).toBeDisabled();
  });

  it("maps the missing required column, then checks the file", async () => {
    setUrl(`/migrasi?job=${JOB}`);
    const calls = api();
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    expect(await screen.findByText("Kolom wajib belum dipetakan: Harga jual.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Periksa berkas" })).toBeDisabled();
    // the guess from the headers is shown, and the preview reads the mapped columns
    expect(screen.getByRole("combobox", { name: /SKU varian/ })).toHaveTextContent("B · SKU");
    expect(screen.getAllByText("KAOS-HTM-L").length).toBeGreaterThan(0);
    // every column of the file shows, with the field reading it, so a wrong header row is plain to see
    expect(screen.getByRole("columnheader", { name: /^B · SKU/ })).toHaveTextContent("→ SKU varian");
    expect(screen.getByRole("columnheader", { name: /^E · Harga Modal/ })).toHaveTextContent("Tidak dipakai");

    await user.click(screen.getByRole("combobox", { name: /Harga jual/ }));
    await user.click(await screen.findByRole("option", { name: "C · Harga Jual" }));
    await user.type(screen.getByLabelText("Simpan pemetaan ini (opsional)"), "BigSeller utama");
    await user.click(screen.getByRole("button", { name: "Periksa berkas" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/validate"))).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      headerRow: 1,
      fields: { product_name: 0, sku: 1, weight: 3, price: 2 },
      weightUnit: "kg",
      dimensionUnit: "cm",
      savePresetAs: "BigSeller utama",
    });
  });

  it("reads the headers again from another row", async () => {
    setUrl(`/migrasi?job=${JOB}`);
    const calls = api();
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    const row = await screen.findByLabelText("Baris judul");
    // the row in use needs no second read
    expect(screen.getByRole("button", { name: "Baca ulang judul" })).toBeDisabled();
    await user.clear(row);
    await user.type(row, "3");
    await user.click(screen.getByRole("button", { name: "Baca ulang judul" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ headerRow: 3 }));
  });

  it("lists the problems of an invalid file with their CSV", async () => {
    setUrl(`/migrasi?job=${JOB}`);
    api(() => job({ status: "invalid", stats: { rows: 2, errors: 1, errorRows: 1 } }));
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    expect(await screen.findByText("1 masalah di 1 baris")).toBeInTheDocument();
    const message = await screen.findByText("Harga harus angka rupiah bulat.");
    expect(message.closest("tr")).toHaveTextContent("3Harga jualHarga harus angka rupiah bulat.");
    expect(screen.getByRole("link", { name: "Unduh daftar masalah (CSV)" })).toHaveAttribute(
      "href",
      `/v1/migration/imports/${JOB}/errors/export`,
    );
    await user.click(screen.getByRole("button", { name: "Unggah berkas baru" }));
    expect(currentUrl()).toBe("/migrasi");
  });

  it("imports a checked file all at once", async () => {
    setUrl(`/migrasi?job=${JOB}`);
    const calls = api(() =>
      job({
        status: "validated",
        stats: {
          rows: 2,
          products: { created: 1, updated: 0 },
          variants: { created: 2, updated: 0 },
          stock: { set: 2, confirmed: 0, skipped: 0 },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp(<MigrationView />);
    expect(await screen.findByText("Berkas siap diimpor")).toBeInTheDocument();
    expect(screen.getByText("2 baru · 0 diperbarui")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Periksa");
    await user.click(screen.getByRole("button", { name: "Impor sekarang" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/import"))).toBe(true));
    expect(within(screen.getByRole("list", { name: "Langkah impor" })).getAllByRole("listitem")).toHaveLength(4);
  });
});
