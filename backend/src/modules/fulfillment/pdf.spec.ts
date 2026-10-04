import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { composeLabels, type PackingList, renderManualLabel, renderPackingList, renderPickList } from "./pdf";
import { A4_PAGE, MM, THERMAL_PAGE } from "./shipping-plan";

/** A marketplace-like label file: `pages` A6 pages. */
async function label(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([105 * MM, 148 * MM]).drawText(`AWB ${i}`, { x: 20, y: 200 });
  return doc.save();
}

describe("composeLabels (FR-SHP-01)", () => {
  it("puts every label page on its own 100 x 150 mm thermal page", async () => {
    const out = await composeLabels([await label(), await label(2)], "thermal");
    expect(out).toMatchObject({ pages: 3, labels: 3, unreadable: [] });
    const doc = await PDFDocument.load(out.pdf);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(THERMAL_PAGE.width, 3);
    expect(height).toBeCloseTo(THERMAL_PAGE.height, 3);
  });

  it("puts four labels on an A4 sheet and reports files that are not PDF", async () => {
    const files = [await label(), await label(), new TextEncoder().encode("<html>bukan pdf</html>"), await label(3)];
    const out = await composeLabels(files, "a4");
    expect(out).toMatchObject({ pages: 2, labels: 5, unreadable: [2] });
    const { width, height } = (await PDFDocument.load(out.pdf)).getPage(1).getSize();
    expect(width).toBeCloseTo(A4_PAGE.width, 3);
    expect(height).toBeCloseTo(A4_PAGE.height, 3);
  });
});

describe("composeLabels with the custom template (FR-SHP-16)", () => {
  const strip = {
    orderNumber: "2410040ABC",
    lines: Array.from({ length: 12 }, (_, i) => ({ qty: i + 1, sku: `SKU-${i}`, variant: "Hitam, L", bin: `A-${i}` })),
    note: "Bungkus kado ✨",
    tags: ["Prioritas", "COD"],
  };

  it("adds the strip under each page of a label and counts the pages of every entry", async () => {
    const out = await composeLabels(
      [{ pdf: await label(), strip }, { pdf: await label(2), strip }, { pdf: await label() }],
      "thermal",
    );
    expect(out).toMatchObject({ pages: 4, labels: 4, unreadable: [], pagesPerEntry: [1, 2, 1] });
    const a4 = await composeLabels([{ pdf: await label(), strip }, await label()], "a4");
    expect(a4).toMatchObject({ pages: 1, labels: 2, pagesPerEntry: [1, 1] });
  });
});

describe("renderPackingList (FR-SHP-03)", () => {
  const list = (lines: number): PackingList => ({
    number: "2410040ABC",
    source: "Shopee · Toko Utama",
    orderedAt: new Date("2026-10-04T03:00:00Z"),
    courier: "SPX Standard",
    trackingNumber: "SPXID0123456789",
    buyer: "Dewi",
    destination: "Surabaya, Jawa Timur",
    lines: Array.from({ length: lines }, (_, i) => ({
      qty: 1 + (i % 3),
      sku: `KAOS-${i}`,
      // characters the font cannot draw are dropped instead of failing the document
      name: `Kaos Polos Cotton Combed 30s Premium 🔥 nomor ${i}`,
      variant: i % 2 ? "Hitam, L" : null,
      bin: i % 4 ? `A-${i}-01` : null,
    })),
    note: "Tolong dibungkus rapi, ini kado ulang tahun untuk adik saya yang sangat suka warna hitam. ".repeat(3),
    tags: ["Prioritas"],
  });

  it("draws a short order on one 100 x 150 mm page", async () => {
    const doc = await PDFDocument.load(await renderPackingList(list(3)));
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getWidth()).toBeCloseTo(THERMAL_PAGE.width, 3);
    expect(doc.getPage(0).getHeight()).toBeCloseTo(THERMAL_PAGE.height, 3);
  });

  it("continues a long order on the next pages", async () => {
    const doc = await PDFDocument.load(await renderPackingList(list(40)));
    expect(doc.getPageCount()).toBeGreaterThan(2);
    for (const page of doc.getPages()) expect(page.getHeight()).toBeCloseTo(THERMAL_PAGE.height, 3);
  });
});

describe("renderPickList (FR-SHP-02)", () => {
  it("draws one section per warehouse and continues long lists on new pages", async () => {
    const line = (i: number) => ({
      warehouseId: "W",
      variantId: null,
      sku: `SKU-${i}`,
      // characters the font cannot draw are dropped instead of failing the document
      name: `Kaos Polos Cotton Combed 30s Premium Lengan Pendek ✨🔥 nomor ${i}`,
      variantName: i % 2 ? "Hitam, XL" : null,
      bin: `A-${i}`,
      qty: i,
      orders: 1,
    });
    const out = await renderPickList({
      generatedAt: new Date("2026-10-03T08:00:00Z"),
      sections: [
        { warehouse: "Gudang Jakarta", orders: 40, lines: Array.from({ length: 60 }, (_, i) => line(i + 1)) },
        { warehouse: "Gudang Surabaya", orders: 1, lines: [line(1)] },
      ],
    });
    expect(out.pages).toBeGreaterThanOrEqual(3);
    const doc = await PDFDocument.load(out.pdf);
    expect(doc.getPageCount()).toBe(out.pages);
    expect(doc.getTitle()).toBe("Daftar ambil");
  });
});

describe("renderManualLabel (FR-ORD-09, FR-WHS-08)", () => {
  const base = {
    number: "MN-2610-0001",
    orderedAt: new Date("2026-10-04T03:00:00Z"),
    business: "Toko Kain Rina",
    sender: { name: "Budi (gudang)", phone: "081234567890", address: "Jl. Raya Darmo 5, Surabaya, Jawa Timur, 60241" },
    recipient: {
      name: "Dewi Anggraini",
      phone: "081298765432",
      address: "Jl. Melati 12 RT 03 RW 04, Kebayoran Baru, Jakarta Selatan, DKI Jakarta, 12130",
    },
    courier: "J&T Express · Reguler",
    trackingNumber: "JT0012345678",
    items: [{ sku: "KAOS-HTM-L", name: "Kaos Polos Hitam, L", qty: 2 }],
    weightG: 400,
    note: "Tolong dibungkus kado 🎁",
  };

  it("draws one 100 x 150 mm page that marketplace labels can be merged with", async () => {
    const pdf = await renderManualLabel({ ...base, cod: 245_000 });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(THERMAL_PAGE.width, 3);
    expect(height).toBeCloseTo(THERMAL_PAGE.height, 3);
    const merged = await composeLabels([pdf, await label()], "a4");
    expect(merged).toMatchObject({ pages: 1, labels: 2, unreadable: [] });
  });

  it("keeps long addresses and many lines on the page", async () => {
    const pdf = await renderManualLabel({
      ...base,
      cod: null,
      trackingNumber: null,
      recipient: { ...base.recipient, address: "Jalan yang sangat panjang sekali ".repeat(20) },
      items: Array.from({ length: 40 }, (_, i) => ({ sku: `SKU-${i}`, name: `Barang ${i}`, qty: 1 })),
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });
});
