import type { Product } from "./product-meta";

export const PRODUCT_ID = "01JPRODUCT0000000000000001";

/** A master product with two variants, as the api answers it. */
export function productFixture(over: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    sku: "KAOS",
    name: "Kaos Polos Cotton Combed 30s",
    description: null,
    brand: null,
    categoryPath: null,
    status: "active",
    attributeNames: ["Warna", "Ukuran"],
    imageUrls: [],
    variants: [
      {
        id: "01JVARIANT0000000000000001",
        sku: "KAOS-HTM-L",
        name: "Hitam, L",
        attributes: { Warna: "Hitam", Ukuran: "L" },
        barcode: null,
        basePrice: 65_000,
        costPrice: 35_000,
        weightG: 200,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        status: "active",
        imageUrl: null,
        listingCount: 2,
      },
      {
        id: "01JVARIANT0000000000000002",
        sku: "KAOS-PTH-L",
        name: "Putih, L",
        attributes: { Warna: "Putih", Ukuran: "L" },
        barcode: "2000000000015",
        basePrice: 70_000,
        costPrice: 36_000,
        weightG: 200,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        status: "active",
        imageUrl: null,
        listingCount: 1,
      },
    ],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}
