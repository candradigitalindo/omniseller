import { describe, expect, it } from "vitest";
import messages from "../../../messages/id.json";
import { localizeCommerceLabel } from "./labels";

const dictionary = messages.commerce.dictionary;
describe("Indonesian commerce business labels", () => {
  it("translates action and business phrases while keeping a natural phrase order", () => {
    expect(localizeCommerceLabel("Get Open Collaboration Products", dictionary)).toBe(
      "Lihat produk kolaborasi terbuka",
    );
    expect(localizeCommerceLabel("Update Product Prices", dictionary)).toBe("Ubah harga produk");
    expect(localizeCommerceLabel("product_id", dictionary)).toBe("ID produk");
  });
  it("removes duplicated generated verbs and preserves unknown scientific terms", () => {
    expect(localizeCommerceLabel("Lihat get_late_orders", dictionary)).toBe("Lihat pesanan terlambat");
    expect(localizeCommerceLabel("Get qPCR Assay", dictionary)).toBe("Lihat qPCR Assay");
    expect(localizeCommerceLabel("qPCR", dictionary)).toBe("qPCR");
  });
});
