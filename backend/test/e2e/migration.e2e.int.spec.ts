import type { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { columnLetter } from "../../src/modules/migration/imports.service";
import { type Client, client, PASSWORD, signup, startApi, startWorker, tokenFrom, uniqueEmail } from "../setup/app";
import { testHandles } from "../setup/handles";
import { MockMarketplace, type MockShopeeItem } from "../setup/mock-marketplace";

/**
 * Moving from another app end to end (PRD 6.20: FR-MIG-01, 05, 06; backend doc 8.19): importing a
 * BigSeller-style Excel export and the OmniSeller template through the column mapping, parallel mode
 * side by side with the marketplace, and the cutover with its checklist and undo.
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 990000;

beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
});

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await mock?.close();
});

async function drain(tenantId: string): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < 20; i++) {
    const round = await worker.runOutbox(tenantId);
    if (round.length === 0) break;
    ran.push(...round);
  }
  return ran;
}

async function business() {
  const { c, me } = await signup(api);
  const warehouseId = (await c.get("/v1/warehouses")).body.items[0].id as string;
  return { c, me, tenantId: me.tenant.id, warehouseId };
}

async function addMember(owner: Client, tenantId: string, role: string, scope?: { storeIds: string[] }) {
  const roles = (await owner.get("/v1/roles")).body.items as { id: string; name: string }[];
  const email = uniqueEmail(role.toLowerCase());
  expect((await owner.post("/v1/invitations", { email, roleId: roles.find((r) => r.name === role)!.id })).status).toBe(
    201,
  );
  await drain(tenantId);
  const member = client(api);
  const accepted = await member.post("/v1/auth/invitations/accept", {
    token: tokenFrom(worker.email.lastTo(email)!.text),
    name: role,
    password: PASSWORD,
  });
  expect(accepted.status).toBe(201);
  if (scope) expect((await owner.put(`/v1/users/${accepted.body.user.id}/scopes`, scope)).status).toBe(200);
  return member;
}

/** A one-sheet workbook as Excel writes it: inline strings, numbers as numbers; base64 for the API. */
function xlsx(rows: (string | number)[][]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r
          .map((v, ci) => {
            const ref = `${columnLetter(ci)}${ri + 1}`;
            if (v === "") return "";
            return typeof v === "number"
              ? `<c r="${ref}"><v>${v}</v></c>`
              : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
          })
          .join("")}</row>`,
    )
    .join("")}</sheetData></worksheet>`;
  const zip = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(
      `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Produk" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="x"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  });
  return Buffer.from(zip).toString("base64");
}

const csv = (rows: string[][]) => Buffer.from(`﻿${rows.map((r) => r.join(";")).join("\r\n")}\r\n`).toString("base64");

/** Runs the worker until the job leaves `status`. */
async function settle(c: Client, tenantId: string, jobId: string) {
  await drain(tenantId);
  return (await c.get(`/v1/migration/imports/${jobId}`)).body;
}

const BIGSELLER_HEADER = [
  "*SKU Gudang",
  "*Judul",
  "Modal (Rp)",
  "Harga Referensi",
  "Berat (kg)",
  "GTIN",
  "Stok",
  "Gudang",
];

describe("import from another app (FR-MIG-01)", () => {
  it("maps a BigSeller export, reports bad rows, and imports the corrected file with initial stock", async () => {
    const { c, me, tenantId, warehouseId } = await business();
    const fields = (await c.get("/v1/migration/fields")).body;
    expect(fields.sourceApps.map((a: { key: string }) => a.key)).toEqual([
      "omniseller",
      "bigseller",
      "ginee",
      "jubelio",
      "spreadsheet",
      "other",
    ]);
    expect(fields.fields.filter((f: { required: boolean }) => f.required).map((f: { key: string }) => f.key)).toEqual([
      "nama_produk",
      "sku_varian",
      "harga_dasar",
      "berat",
    ]);

    const bad = xlsx([
      ["Petunjuk: isi mulai baris 3. Kolom bertanda * wajib."],
      BIGSELLER_HEADER,
      ["MIG-1", "Kaos Migrasi", 20000, 50000, 0.25, "8991000000010", 10, "UTAMA"],
      ["MIG-2", "Topi Migrasi", "15.000", "65.000,50", 0.1, "", 4, "Gudang X"],
      [],
      ["MIG-3", "Tas Migrasi", 30000, 90000, 0.5, "", "", ""],
    ]);
    const up = await c.post("/v1/migration/imports", {
      sourceApp: "bigseller",
      fileName: "bigseller.xlsx",
      content: bad,
    });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({
      status: "uploaded",
      fileType: "xlsx",
      sourceAppName: "BigSeller",
      columns: BIGSELLER_HEADER,
      stats: { rows: 3 },
      mapping: {
        headerRow: 2,
        weightUnit: "kg",
        fields: {
          sku_varian: 0,
          nama_produk: 1,
          hpp: 2,
          harga_dasar: 3,
          berat: 4,
          barcode: 5,
          stok_awal: 6,
          gudang: 7,
        },
      },
    });
    expect(up.body.preview[0]).toEqual([
      "MIG-1",
      "Kaos Migrasi",
      "20000",
      "50000",
      "0.25",
      "8991000000010",
      "10",
      "UTAMA",
    ]);
    // importing needs a validated file
    expect((await c.post(`/v1/migration/imports/${up.body.id}/import`, {})).status).toBe(409);

    expect((await c.post(`/v1/migration/imports/${up.body.id}/validate`, {})).body.status).toBe("validating");
    // nothing may change while the worker validates
    expect((await c.put(`/v1/migration/imports/${up.body.id}/mapping`, up.body.mapping)).body.code).toBe(
      "migration.busy",
    );
    const invalid = await settle(c, tenantId, up.body.id);
    expect(invalid).toMatchObject({ status: "invalid", stats: { rows: 3, errors: 2, errorRows: 1 } });
    const errors = (await c.get(`/v1/migration/imports/${up.body.id}/errors`)).body.items;
    expect(errors).toEqual([
      expect.objectContaining({ rowNumber: 4, field: "harga_dasar", fieldLabel: "Harga jual" }),
      expect.objectContaining({ rowNumber: 4, field: "gudang", message: 'Gudang "Gudang X" tidak ditemukan.' }),
    ]);
    expect(errors[0].raw.slice(0, 4)).toEqual(["MIG-2", "Topi Migrasi", "15.000", "65.000,50"]);
    const failedRows = await c.get(`/v1/migration/imports/${up.body.id}/errors/export`);
    expect(failedRows.headers["content-disposition"]).toBe('attachment; filename="bigseller-gagal.csv"');
    expect(failedRows.text).toContain("baris;kolom;masalah;*SKU Gudang;*Judul");
    expect(failedRows.text).toContain("4;Harga jual;Harus angka rupiah tanpa desimal");
    // nothing was written by the validation
    expect((await c.get("/v1/products?q=MIG-")).body.items).toEqual([]);

    // the corrected file
    const good = xlsx([
      BIGSELLER_HEADER,
      ["MIG-1", "Kaos Migrasi", 20000, 50000, 0.25, "8991000000010", 10, "UTAMA"],
      ["MIG-2", "Topi Migrasi", "15.000", "65.000", 0.1, "", 4, ""],
      ["MIG-3", "Tas Migrasi", 30000, 90000, 0.5, "", "", ""],
    ]);
    const second = (
      await c.post("/v1/migration/imports", { sourceApp: "bigseller", fileName: "bigseller-2.xlsx", content: good })
    ).body;
    expect(second.mapping.headerRow).toBe(1);
    await c.post(`/v1/migration/imports/${second.id}/validate`, {});
    const validated = await settle(c, tenantId, second.id);
    expect(validated).toMatchObject({
      status: "validated",
      stats: { rows: 3, errors: 0, products: { created: 3, updated: 0 }, variants: { created: 3, updated: 0 } },
    });
    expect((await c.post(`/v1/migration/imports/${second.id}/import`, {})).body.status).toBe("importing");
    const imported = await settle(c, tenantId, second.id);
    expect(imported).toMatchObject({
      status: "imported",
      stats: { products: { created: 3 }, stock: { set: 2, confirmed: 0, skipped: 0 } },
    });
    expect((await c.post(`/v1/migration/imports/${second.id}/import`, {})).body.code).toBe(
      "migration.already_imported",
    );

    const product = (await c.get("/v1/products?q=MIG-1")).body.items[0];
    expect(product).toMatchObject({ sku: "MIG-1", name: "Kaos Migrasi" });
    expect(product.variants[0]).toMatchObject({
      sku: "MIG-1",
      costPrice: 20000,
      basePrice: 50000,
      weightG: 250,
      barcode: "8991000000010",
    });
    const stock = (await c.get("/v1/inventory?q=MIG-2")).body.items[0];
    expect(stock.warehouses[0]).toMatchObject({ warehouseId, onHand: 4 });
    const card = (await c.get(`/v1/inventory/movements?variantId=${stock.id}`)).body.items;
    expect(card).toEqual([
      expect.objectContaining({
        type: "migration_initial",
        onHandDelta: 4,
        referenceType: "migration_job",
        referenceId: second.id,
        note: "Impor bigseller-2.xlsx",
        actorUserId: me.user.id,
      }),
    ]);

    // the same file again updates the products and leaves established stock alone
    const again = (
      await c.post("/v1/migration/imports", { sourceApp: "bigseller", fileName: "ulang.xlsx", content: good })
    ).body;
    await c.post(`/v1/migration/imports/${again.id}/validate`, {});
    await settle(c, tenantId, again.id);
    await c.post(`/v1/migration/imports/${again.id}/import`, {});
    expect(await settle(c, tenantId, again.id)).toMatchObject({
      status: "imported",
      stats: { products: { created: 0, updated: 3 }, stock: { set: 0, skipped: 2 } },
    });

    const kinds = ((await c.get("/v1/notifications")).body.items as { kind: string }[]).map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["migration.invalid", "migration.validated", "migration.imported"]));
    const audit = (await c.get(`/v1/audit-logs?entity_type=migration_job&entity_id=${up.body.id}`)).body.items;
    expect(audit).toEqual([expect.objectContaining({ action: "insert", actorId: me.user.id })]);
    expect((await c.get("/v1/migration/imports")).body.items.map((j: { id: string }) => j.id)).toEqual([
      again.id,
      second.id,
      up.body.id,
    ]);
  });

  it("imports the OmniSeller template with variants, attributes, images, and a saved mapping", async () => {
    const { c, tenantId } = await business();
    const header = [
      "sku_induk",
      "nama_produk",
      "kategori",
      "sku_varian",
      "nama_varian",
      "atribut_1_nama",
      "atribut_1_nilai",
      "atribut_2_nama",
      "atribut_2_nilai",
      "hpp",
      "harga_dasar",
      "berat_gram",
      "panjang_cm",
      "lebar_cm",
      "tinggi_cm",
      "url_gambar_1",
      "url_gambar_2",
    ];
    const rows = [
      header,
      [
        "POLO",
        "Kaos Polo",
        "Fashion > Pria",
        "POLO-HTM-L",
        "Hitam, L",
        "Warna",
        "Hitam",
        "Ukuran",
        "L",
        "35000",
        "65000",
        "200",
        "25",
        "20",
        "3",
        "https://cdn.contoh.id/polo.jpg",
        "https://cdn.contoh.id/polo-2.jpg",
      ],
      [
        "POLO",
        "Kaos Polo",
        "Fashion > Pria",
        "POLO-PTH-M",
        "Putih, M",
        "Warna",
        "Putih",
        "Ukuran",
        "M",
        "35000",
        "65000",
        "190",
        "25",
        "20",
        "3",
        "https://cdn.contoh.id/polo.jpg",
        "https://cdn.contoh.id/polo-2.jpg",
      ],
    ];
    const job = (
      await c.post("/v1/migration/imports", { sourceApp: "omniseller", fileName: "templat.csv", content: csv(rows) })
    ).body;
    expect(job).toMatchObject({ fileType: "csv", mapping: { headerRow: 1, dimensionUnit: "cm" } });
    // keep this mapping for the next file of the same layout
    const kept = await c.put(`/v1/migration/imports/${job.id}/mapping`, {
      ...job.mapping,
      savePresetAs: "Templat toko",
    });
    expect(kept.status).toBe(200);
    expect(
      (await c.put(`/v1/migration/imports/${job.id}/mapping`, { ...job.mapping, savePresetAs: " templat TOKO " })).body
        .code,
    ).toBe("migration_preset.name_taken");
    await c.post(`/v1/migration/imports/${job.id}/validate`, {});
    expect((await settle(c, tenantId, job.id)).status).toBe("validated");
    await c.post(`/v1/migration/imports/${job.id}/import`, {});
    expect(await settle(c, tenantId, job.id)).toMatchObject({
      status: "imported",
      stats: { products: { created: 1 }, variants: { created: 2 } },
    });
    const polo = (await c.get("/v1/products?q=POLO")).body.items[0];
    expect(polo).toMatchObject({
      sku: "POLO",
      name: "Kaos Polo",
      categoryPath: "Fashion > Pria",
      attributeNames: ["Warna", "Ukuran"],
      imageUrls: ["https://cdn.contoh.id/polo.jpg", "https://cdn.contoh.id/polo-2.jpg"],
    });
    expect(polo.variants.find((v: { sku: string }) => v.sku === "POLO-HTM-L")).toMatchObject({
      attributes: { Warna: "Hitam", Ukuran: "L" },
      costPrice: 35000,
      weightG: 200,
      lengthMm: 250,
      widthMm: 200,
      heightMm: 30,
    });

    // the saved mapping finds its columns in a file laid out differently
    const presets = (await c.get("/v1/migration/presets")).body.items;
    expect(presets).toEqual([expect.objectContaining({ name: "Templat toko", sourceApp: "omniseller" })]);
    const shuffled = [...header].reverse();
    const next = (
      await c.post("/v1/migration/imports", {
        sourceApp: "spreadsheet",
        fileName: "lain.csv",
        content: csv([shuffled, [...rows[1]!].reverse()]),
        presetId: presets[0].id,
      })
    ).body;
    expect(next.sourceApp).toBe("omniseller");
    expect(next.mapping.fields).toMatchObject({ sku_induk: 16, nama_produk: 15, sku_varian: 13, harga_dasar: 6 });
    expect((await c.delete(`/v1/migration/presets/${presets[0].id}`)).status).toBe(204);
    expect((await c.delete(`/v1/migration/presets/${presets[0].id}`)).status).toBe(404);
  });

  it("refuses unreadable files and incomplete mappings, and needs the right permissions", async () => {
    const { c, tenantId } = await business();
    const post = (content: string, fileName = "x.csv") =>
      c.post("/v1/migration/imports", { sourceApp: "spreadsheet", fileName, content });
    expect((await post(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]).toString("base64"), "lama.xls")).body).toMatchObject(
      {
        code: "migration.file_unreadable",
        detail: "Format .xls lama tidak didukung. Simpan ulang sebagai .xlsx atau CSV.",
      },
    );
    expect((await post(Buffer.from([1, 0, 2]).toString("base64"))).body.code).toBe("migration.file_unreadable");
    expect((await post(csv([["SKU", "Nama"]]))).body.code).toBe("migration.no_rows");

    const job = (
      await post(
        csv([
          ["Kode", "Judul Barang", "Harga Jual"],
          ["A-1", "Barang", "1000"],
        ]),
      )
    ).body;
    expect(job.mapping.fields).toEqual({ harga_dasar: 2 });
    const incomplete = await c.put(`/v1/migration/imports/${job.id}/mapping`, {
      ...job.mapping,
      fields: { harga_dasar: 2, sku_varian: 7 },
    });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.errors.map((e: { path: string }) => e.path)).toEqual([
      "fields.sku_varian",
      "fields.nama_produk",
      "fields.berat",
    ]);
    expect((await c.post(`/v1/migration/imports/${job.id}/validate`, {})).status).toBe(422);
    // a header row lower in the file reads the columns again
    const moved = await c.put(`/v1/migration/imports/${job.id}/mapping`, {
      headerRow: 2,
      fields: { sku_varian: 0, nama_produk: 1, harga_dasar: 2, berat: 2 },
      weightUnit: "g",
      dimensionUnit: "cm",
    });
    expect(moved.status).toBe(422);
    expect(moved.body.code).toBe("migration.no_rows");

    const gudang = await addMember(c, tenantId, "Gudang");
    expect((await gudang.get("/v1/migration/imports")).status).toBe(403);
  });
});

describe("parallel mode and cutover (FR-MIG-05, 06)", () => {
  const kaosItem = (itemId: number, m: number, l: number): MockShopeeItem => ({
    item_id: itemId,
    item_name: "Kaos",
    item_sku: "KAOS",
    item_status: "NORMAL",
    update_time: 1_700_000_000,
    tiers: [{ name: "Ukuran", options: ["M", "L"] }],
    models: [
      { model_id: itemId * 10 + 1, model_sku: "KAOS-M", tier_index: [0], price: 50_000, stock: m },
      { model_id: itemId * 10 + 2, model_sku: "KAOS-L", tier_index: [1], price: 50_000, stock: l },
    ],
  });

  async function connect(c: Client, tenantId: string, items: MockShopeeItem[]) {
    const shopId = String(++shopSeq);
    mock.addShopeeShop({
      shopId,
      name: `Toko ${shopId}`,
      region: "ID",
      warehouses: "not_whitelisted",
      items,
      orders: [],
    });
    const started = await c.post("/v1/store-authorizations", { channel: "shopee" });
    await c.post("/v1/store-authorizations/callback", {
      channel: "shopee",
      state: new URL(started.body.authorizeUrl).searchParams.get("state"),
      code: mock.shopeeCode({ shopId }),
      shopId,
    });
    await drain(tenantId);
    const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0]
      .storeId as string;
    return { shopId, storeId };
  }

  const updatesTo = (shopId: string) =>
    mock.callsTo("POST", "/api/v2/product/update_stock").filter((x) => x.query.shop_id === shopId);

  it("compares stock side by side, refuses a cutover until the checklist passes, then moves and undoes", async () => {
    const { c, tenantId, warehouseId } = await business();
    const variants = (
      await c.post("/v1/products", {
        sku: "KAOS",
        name: "Kaos",
        variants: [
          { sku: "KAOS-M", basePrice: 50_000, weightG: 200 },
          { sku: "KAOS-L", basePrice: 50_000, weightG: 200 },
        ],
      })
    ).body.variants as { id: string; sku: string }[];
    const v = Object.fromEntries(variants.map((x) => [x.sku, x.id]));
    const { shopId, storeId } = await connect(c, tenantId, [kaosItem(991, 5, 3)]);

    let [state] = (await c.get("/v1/migration/parallel")).body.items;
    expect(state).toMatchObject({
      id: storeId,
      syncMode: "read_only",
      parallelDays: 0,
      unmappedListings: 0,
      unmappedWarehouses: 0,
      stock: { counts: { unset: 2, differ: 0, match: 0 }, unverified: 0, blocked: null },
      ready: true,
    });
    expect(state.checklist.filter((i: { ok: boolean }) => !i.ok).map((i: { key: string }) => i.key)).toEqual([
      "old_app_revoked",
      "parallel_days",
      "stock_unset",
    ]);

    // OmniSeller takes the marketplace's stock as its own, then counts one more M than the marketplace shows
    expect((await c.post("/v1/inventory/initial-stock", { storeId })).status).toBe(200);
    expect((await c.get("/v1/migration/parallel")).body.items[0].stock.counts).toMatchObject({ match: 2, unset: 0 });
    await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 7 }],
      reason: "correction",
    });
    const comparison = (await c.get(`/v1/migration/stores/${storeId}/stock-comparison?status=differ`)).body;
    expect(comparison).toMatchObject({ counts: { differ: 1, match: 1 }, more: false });
    expect(comparison.items).toEqual([
      expect.objectContaining({ sku: "KAOS-M", status: "differ", marketplace: 5, omniseller: 7, difference: 2 }),
    ]);

    // acceptance (PRD 13.2): in parallel mode not a single stock push reaches the marketplace
    await drain(tenantId);
    await worker.flushStock(tenantId);
    expect(updatesTo(shopId)).toEqual([]);

    expect((await c.post("/v1/migration/cutover", { oldAppRevoked: false })).status).toBe(422);
    const refused = await c.post("/v1/migration/cutover", { oldAppRevoked: true });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "cutover.checklist_failed",
      stores: [{ storeId, failed: [{ key: "stock_match", detail: "1 listing stoknya berbeda." }] }],
    });

    // acceptance: a listing nobody mapped blocks the cutover too
    await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["KAOS-M"], warehouseId, mode: "set", quantity: 5 }],
      reason: "correction",
    });
    mock.shopeeShops.get(shopId)!.items!.push({
      item_id: 992,
      item_name: "Tas",
      item_sku: "TAS-1",
      item_status: "NORMAL",
      update_time: 1_700_000_100,
      price: 1,
      stock: 2,
    });
    expect((await c.post("/v1/listings/sync", { storeId, full: true })).status).toBe(202);
    await drain(tenantId);
    const blocked = await c.post("/v1/migration/cutover", { storeIds: [storeId], oldAppRevoked: true });
    expect(blocked.body.stores[0].failed).toEqual([
      { key: "listings_mapped", detail: "1 listing belum terhubung ke produk." },
    ]);

    // mapped, but the marketplace stock was pulled too long ago
    const tas = (
      await c.post("/v1/products", {
        sku: "TAS-1",
        name: "Tas",
        variants: [{ sku: "TAS-1", basePrice: 1, weightG: 300 }],
      })
    ).body.variants[0].id;
    const listing = (await c.get(`/v1/listings/unmapped?storeId=${storeId}`)).body.items[0];
    expect((await c.put(`/v1/listings/${listing.id}/mapping`, { variantId: tas })).status).toBe(200);
    await h.system.db.execute(
      sql`UPDATE store SET last_product_sync_at = now() - interval '2 hours' WHERE id = ${storeId}`,
    );
    [state] = (await c.get(`/v1/migration/cutover-check?storeId=${storeId}`)).body.items;
    expect(
      state.checklist
        .filter((i: { ok: boolean; blocking: boolean }) => !i.ok && i.blocking)
        .map((i: { key: string }) => i.key),
    ).toEqual(["stock_fresh", "old_app_revoked"]);
    await c.post("/v1/listings/sync", { storeId, full: true });
    await drain(tenantId);
    [state] = (await c.get(`/v1/migration/cutover-check?storeId=${storeId}`)).body.items;
    expect(state).toMatchObject({ ready: true, stock: { counts: { match: 2, unset: 1, differ: 0 } } });

    const moved = await c.post("/v1/migration/cutover", { oldAppRevoked: true });
    expect(moved.status).toBe(200);
    const [cutover] = moved.body.items;
    expect(cutover).toMatchObject({ storeId, status: "done", canUndo: true, checklist: { oldAppRevoked: true } });
    expect(Date.parse(cutover.undoUntil) - Date.parse(cutover.createdAt)).toBeGreaterThan(23.9 * 3600_000);
    expect((await c.get(`/v1/stores/${storeId}`)).body.syncMode).toBe("live");
    // live: OmniSeller now sends stock (the values both systems agreed on)
    await drain(tenantId);
    await worker.flushStock(tenantId);
    expect(updatesTo(shopId).length).toBeGreaterThan(0);
    expect(
      (await c.post("/v1/migration/cutover", { storeIds: [storeId], oldAppRevoked: true })).body.stores[0].failed,
    ).toEqual([{ key: "already_live", detail: "Toko ini sudah memakai OmniSeller sepenuhnya." }]);

    // undo within 24 hours: back to parallel mode, once
    const undone = await c.post(`/v1/migration/cutovers/${cutover.id}/undo`, {});
    expect(undone.body).toMatchObject({ status: "undone", canUndo: false });
    expect((await c.get(`/v1/stores/${storeId}`)).body.syncMode).toBe("read_only");
    expect((await c.post(`/v1/migration/cutovers/${cutover.id}/undo`, {})).body.code).toBe("cutover.already_undone");

    // after 24 hours a cutover stays
    const again = (await c.post("/v1/migration/cutover", { oldAppRevoked: true })).body.items[0];
    await h.system.db.execute(
      sql`UPDATE store_cutover SET undo_until = now() - interval '1 minute' WHERE id = ${again.id}`,
    );
    expect((await c.post(`/v1/migration/cutovers/${again.id}/undo`, {})).body.code).toBe("cutover.undo_expired");
    expect(
      (await c.get("/v1/migration/cutovers")).body.items.map((x: { id: string; status: string }) => [x.id, x.status]),
    ).toEqual([
      [again.id, "done"],
      [cutover.id, "undone"],
    ]);
    // a user limited to another store sees only that one
    const second = await connect(c, tenantId, [kaosItem(993, 1, 1)]);
    const other = await addMember(c, tenantId, "Admin", { storeIds: [second.storeId] });
    expect((await other.get(`/v1/migration/cutover-check?storeId=${storeId}`)).status).toBe(404);
    expect((await other.get("/v1/migration/parallel")).body.items.map((x: { id: string }) => x.id)).toEqual([
      second.storeId,
    ]);
    expect((await other.post(`/v1/migration/cutovers/${again.id}/undo`, {})).status).toBe(404);
    expect((await other.get("/v1/migration/cutovers")).body.items).toEqual([]);
    const audit = (await c.get(`/v1/audit-logs?entity_type=store_cutover&entity_id=${cutover.id}`)).body.items;
    expect(audit.map((x: { action: string }) => x.action).sort()).toEqual(["insert", "update"]);
  });
});
