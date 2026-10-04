import { describe, expect, it } from "vitest";
import { nearness, provinceOf } from "./region";

describe("Indonesian provinces", () => {
  it("reads province names the way marketplaces and sellers write them", () => {
    expect(provinceOf("DKI JAKARTA")).toEqual({ name: "DKI Jakarta", island: "jawa" });
    expect(provinceOf("Jakarta")?.name).toBe("DKI Jakarta");
    expect(provinceOf("D.K.I. Jakarta")?.name).toBe("DKI Jakarta");
    expect(provinceOf("NANGGROE ACEH DARUSSALAM (NAD)")?.name).toBe("Aceh");
    expect(provinceOf("Provinsi Jawa Timur")?.name).toBe("Jawa Timur");
    expect(provinceOf("jatim")?.name).toBe("Jawa Timur");
    expect(provinceOf("Daerah Istimewa Yogyakarta")?.name).toBe("DI Yogyakarta");
    expect(provinceOf("KEPULAUAN BANGKA BELITUNG")?.name).toBe("Kepulauan Bangka Belitung");
    expect(provinceOf("Papua Barat Daya")).toEqual({ name: "Papua Barat Daya", island: "papua" });
  });

  it("knows nothing about names it cannot place", () => {
    expect(provinceOf("Selangor")).toBeNull();
    expect(provinceOf("")).toBeNull();
    expect(provinceOf(null)).toBeNull();
  });

  it("ranks the same province over the same island over the rest", () => {
    expect(nearness("JAWA TIMUR", "Jawa Timur")).toBe(2);
    expect(nearness("Jawa Tengah", "Jawa Timur")).toBe(1);
    expect(nearness("Bali", "Jawa Timur")).toBe(0);
    expect(nearness(null, "Jawa Timur")).toBe(0);
  });
});
