import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type Warehouse = components["schemas"]["WarehouseDto_Output"];
export type ChannelWarehouse = components["schemas"]["ChannelWarehouseListDto_Output"]["items"][number];
type Address = Warehouse["address"];

/** Mapping pills (L20): mapped green, unmapped red (stock sync stops), managed by the marketplace gray. */
export const MAPPING_TONE: Record<ChannelWarehouse["mappingStatus"], Tone> = {
  mapped: "success",
  unmapped: "danger",
  marketplace_managed: "neutral",
};

export interface WarehouseForm {
  code: string;
  name: string;
  contactName: string;
  phone: string;
  line1: string;
  district: string;
  city: string;
  province: string;
  postalCode: string;
  isDefault: boolean;
}

export function emptyForm(): WarehouseForm {
  return {
    code: "",
    name: "",
    contactName: "",
    phone: "",
    line1: "",
    district: "",
    city: "",
    province: "",
    postalCode: "",
    isDefault: false,
  };
}

export function formOf(w: Warehouse): WarehouseForm {
  const a = w.address;
  return {
    code: w.code,
    name: w.name,
    contactName: a.contactName ?? "",
    phone: a.phone ?? "",
    line1: a.line1 ?? "",
    district: a.district ?? "",
    city: a.city ?? "",
    province: a.province ?? "",
    postalCode: a.postalCode ?? "",
    isDefault: w.isDefault,
  };
}

/** 2 to 20 capitals, digits, or hyphens (backend 8.21); typed in lower case it is raised first. */
const CODE = /^[A-Z0-9-]{2,20}$/;

export function warehouseProblems(f: WarehouseForm): Record<string, "code" | "required"> {
  const out: Record<string, "code" | "required"> = {};
  if (!CODE.test(f.code.trim().toUpperCase())) out.code = "code";
  if (!f.name.trim()) out.name = "required";
  return out;
}

/** The request: the code in capitals, the address replaced as a whole with only what was typed. */
export function warehouseBody(f: WarehouseForm): { code: string; name: string; address: Address } {
  const address: Address = {};
  for (const key of ["contactName", "phone", "line1", "district", "city", "province", "postalCode"] as const) {
    const v = f[key].trim();
    if (v) address[key] = v;
  }
  return { code: f.code.trim().toUpperCase(), name: f.name.trim(), address };
}

/** The address as it would be written on a parcel, line by line. */
export function addressLines(a: Address): string[] {
  const contact = [a.contactName, a.phone].filter(Boolean).join(" · ");
  const place = [a.district, a.city].filter(Boolean).join(", ");
  const region = [a.province, a.postalCode].filter(Boolean).join(" ");
  return [contact, a.line1 ?? "", place, region].filter((l) => l.trim() !== "");
}
