import { describe, expect, it } from "vitest";
import type { Permission } from "@/lib/session";
import type { StoreStatus } from "../stores/store-meta";
import {
  addressLines,
  canCancel,
  type OrderDetail,
  primaryActionOf,
  stepOf,
  syncableStores,
  tabCount,
  tabOf,
} from "./order-meta";

const everything = () => true;
const only =
  (...allowed: Permission[]) =>
  (p: Permission) =>
    allowed.includes(p);

type Input = Parameters<typeof primaryActionOf>[0];
const order = (over: Partial<Input> = {}): Input => ({
  status: "new",
  fulfillmentMode: "seller",
  shippingAddress: { fullAddress: "Jl. Melati 5" },
  addressHidden: false,
  channel: "shopee",
  ...over,
});

describe("tabs", () => {
  it("maps a status in the URL to its tab, and a tab key to itself", () => {
    expect(tabOf("new")).toBe("new");
    expect(tabOf("returns")).toBe("returns");
    expect(tabOf("shipped")).toBe("shipped");
    expect(tabOf(null)).toBe("all");
    expect(tabOf("nonsense")).toBe("all");
  });

  it("counts a tab from the summary, summing its statuses", () => {
    const statuses = { shipped: 4, delivered: 3, new: 2 };
    expect(tabCount("shipped", statuses)).toBe(7);
    expect(tabCount("new", statuses)).toBe(2);
    expect(tabCount("cancelled", statuses)).toBe(0);
    expect(tabCount("all", statuses)).toBeNull();
  });
});

describe("primaryActionOf", () => {
  it("walks a marketplace order through accept, pack, arrange, label", () => {
    expect(primaryActionOf(order({ status: "new" }), everything)).toBe("accept");
    expect(primaryActionOf(order({ status: "ready_to_pack" }), everything)).toBe("pack");
    expect(primaryActionOf(order({ status: "packed" }), everything)).toBe("arrange");
    expect(primaryActionOf(order({ status: "ready_to_ship" }), everything)).toBe("label");
    expect(primaryActionOf(order({ status: "shipped" }), everything)).toBeNull();
    expect(primaryActionOf(order({ status: "problem" }), everything)).toBeNull();
  });

  it("offers nothing for orders the marketplace ships", () => {
    expect(primaryActionOf(order({ fulfillmentMode: "marketplace" }), everything)).toBeNull();
  });

  it("hides an action the user may not take", () => {
    expect(primaryActionOf(order({ status: "new" }), only("order:read"))).toBeNull();
    expect(primaryActionOf(order({ status: "ready_to_pack" }), only("shipment:pack"))).toBe("pack");
    expect(primaryActionOf(order({ status: "ready_to_ship" }), only("shipment:arrange"))).toBeNull();
  });

  it("walks a manual order through pay, ship, complete", () => {
    const manual = (over: Partial<Input>) => order({ channel: "manual", ...over });
    expect(primaryActionOf(manual({ status: "unpaid" }), everything)).toBe("pay");
    expect(primaryActionOf(manual({ status: "new" }), everything)).toBe("ship");
    expect(primaryActionOf(manual({ status: "packed" }), everything)).toBe("ship");
    expect(primaryActionOf(manual({ status: "shipped" }), everything)).toBe("complete");
    // sold on the spot: nothing to ship
    expect(primaryActionOf(manual({ status: "new", shippingAddress: null }), everything)).toBe("complete");
    // the address is hidden from this role, but it is there
    expect(primaryActionOf(manual({ status: "new", shippingAddress: null, addressHidden: true }), everything)).toBe(
      "ship",
    );
    expect(primaryActionOf(manual({ status: "completed" }), everything)).toBeNull();
  });
});

describe("canCancel", () => {
  const o = (over: Partial<Pick<OrderDetail, "status" | "fulfillmentMode" | "cancelRequested">>) => ({
    status: "new" as const,
    fulfillmentMode: "seller" as const,
    cancelRequested: false,
    ...over,
  });
  it("allows the seller's statuses only, once", () => {
    expect(canCancel(o({}))).toBe(true);
    expect(canCancel(o({ status: "ready_to_ship" }))).toBe(true);
    expect(canCancel(o({ status: "shipped" }))).toBe(false);
    expect(canCancel(o({ fulfillmentMode: "marketplace" }))).toBe(false);
    expect(canCancel(o({ cancelRequested: true }))).toBe(false);
  });
});

describe("stepOf", () => {
  it("places statuses on the four steps and leaves the rest off", () => {
    expect(stepOf("problem")).toBe(0);
    expect(stepOf("ready_to_ship")).toBe(1);
    expect(stepOf("delivered")).toBe(2);
    expect(stepOf("completed")).toBe(3);
    expect(stepOf("cancelled")).toBeNull();
    expect(stepOf("unpaid")).toBeNull();
  });
});

describe("addressLines", () => {
  it("reads a marketplace address without repeating the area its full address already has", () => {
    const a = addressLines({
      name: "Dewi A.",
      phone: "0812****78",
      fullAddress: "Jl. Melati 5, Coblong, Kota Bandung, Jawa Barat, 40132",
      district: "Coblong",
      city: "Kota Bandung",
      province: "Jawa Barat",
      postalCode: "40132",
    });
    expect(a).toEqual({
      name: "Dewi A.",
      phone: "0812****78",
      lines: ["Jl. Melati 5, Coblong, Kota Bandung, Jawa Barat, 40132"],
    });
  });

  it("reads a manual order's address with its area on a second line", () => {
    const a = addressLines({ line1: "Jl. Kenanga 12", city: "Surabaya", province: "Jawa Timur", postalCode: "60111" });
    expect(a.lines).toEqual(["Jl. Kenanga 12", "Surabaya, Jawa Timur, 60111"]);
    expect(a.name).toBeNull();
  });

  it("ignores blanks and values that are not text", () => {
    expect(addressLines({ name: " ", fullAddress: 5 })).toEqual({ name: null, phone: null, lines: [] });
    expect(addressLines(null).lines).toEqual([]);
  });
});

describe("reading a store's orders again", () => {
  it("offers marketplace stores whose connection works", () => {
    const stores: { id: string; channel: string; status: StoreStatus }[] = [
      { id: "a", channel: "shopee", status: "active" },
      { id: "b", channel: "tiktokshop", status: "token_expiring" },
      { id: "c", channel: "shopee", status: "reauth_required" },
      { id: "d", channel: "shopee", status: "disconnected" },
      { id: "e", channel: "shopee", status: "connecting" },
      { id: "f", channel: "manual", status: "active" },
    ];
    expect(syncableStores(stores).map((s) => s.id)).toEqual(["a", "b"]);
  });
});
