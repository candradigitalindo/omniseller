import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { composeLabels, renderPickList } from "./pdf";
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
