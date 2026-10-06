import { describe, expect, it } from "vitest";
import { addressLines, emptyForm, formOf, warehouseBody, warehouseProblems } from "./warehouse-meta";

describe("warehouse form", () => {
  it("takes codes of 2 to 20 capitals, digits, or hyphens, typed in any case", () => {
    expect(warehouseProblems({ ...emptyForm(), code: "sby-2", name: "Gudang Surabaya" })).toEqual({});
    expect(warehouseProblems({ ...emptyForm(), code: "S", name: " " })).toEqual({ code: "code", name: "required" });
    expect(warehouseProblems({ ...emptyForm(), code: "GUDANG UTAMA", name: "x" })).toEqual({ code: "code" });
  });

  it("sends the code in capitals and only the address parts that were typed", () => {
    expect(
      warehouseBody({
        ...emptyForm(),
        code: " sby ",
        name: " Gudang Surabaya ",
        city: "Kota Surabaya",
        province: "Jawa Timur",
        phone: " ",
      }),
    ).toEqual({
      code: "SBY",
      name: "Gudang Surabaya",
      address: { city: "Kota Surabaya", province: "Jawa Timur" },
    });
  });

  it("starts an edit from the warehouse and writes its address line by line", () => {
    const w = {
      id: "W1",
      code: "JKT",
      name: "Gudang Jakarta",
      isDefault: true,
      active: true,
      address: {
        contactName: "Rina",
        phone: "0812",
        line1: "Jl. Melati 5",
        city: "Jakarta Selatan",
        province: "DKI Jakarta",
        postalCode: "12430",
      },
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    expect(formOf(w)).toMatchObject({ code: "JKT", line1: "Jl. Melati 5", district: "", isDefault: true });
    expect(addressLines(w.address)).toEqual(["Rina · 0812", "Jl. Melati 5", "Jakarta Selatan", "DKI Jakarta 12430"]);
    expect(addressLines({})).toEqual([]);
  });
});
