import { describe, expect, it } from "vitest";
import {
  addLine,
  availableFor,
  type Draft,
  type DraftLine,
  defaultPaid,
  draftProblems,
  emptyDraft,
  localInput,
  manualOrderBody,
  type PickedVariant,
  totals,
  zonedToIso,
} from "./manual-order-meta";

const shirt: PickedVariant = {
  variantId: "01JVARIANT0000000000000001",
  sku: "KAOS-HTM",
  productName: "Kaos Polos",
  variantName: "Hitam",
  basePrice: 65_000,
  stock: { W1: 4, W2: 10 },
};
const line = (over: Partial<DraftLine> = {}): DraftLine => ({ ...shirt, qty: "2", unitPrice: "60000", ...over });

function draft(over: Partial<Draft> = {}): Draft {
  return {
    ...emptyDraft(),
    buyerName: "Dewi Anggraini",
    buyerPhone: "081234567801",
    line1: "Jl. Melati No. 5",
    lines: [line()],
    ...over,
  };
}

const NOW = "2026-10-06T10:00";
const EARLIEST = "2026-07-08T10:00";

describe("order lines", () => {
  it("adds a variant at its price, and one more when it is there already", () => {
    const once = addLine([], shirt);
    expect(once).toEqual([{ ...shirt, qty: "1", unitPrice: "65000" }]);
    const twice = addLine(addLine(once, shirt), shirt);
    expect(twice).toHaveLength(1);
    expect(twice[0]?.qty).toBe("3");
  });

  it("reads stock from the chosen warehouse, or the best one when the api allocates", () => {
    expect(availableFor(line(), "W1")).toBe(4);
    expect(availableFor(line(), "W3")).toBe(0);
    expect(availableFor(line(), "")).toBe(10);
    expect(availableFor(line({ stock: {} }), "")).toBe(0);
    expect(availableFor(line({ stock: null }), "")).toBeNull();
  });

  it("totals lines, takes the discount off, and adds shipping only when sent", () => {
    const d = draft({
      lines: [line(), line({ variantId: "V2", qty: "1", unitPrice: "15000" })],
      discount: "5000",
      shippingFee: "12000",
    });
    expect(totals(d)).toEqual({ subtotal: 135_000, discount: 5_000, shippingFee: 12_000, total: 142_000 });
    expect(totals({ ...d, shipTo: "pickup" }).total).toBe(130_000);
  });

  it("treats cash as paid and everything else as not yet", () => {
    expect(defaultPaid("cash")).toBe(true);
    expect(defaultPaid("transfer")).toBe(false);
    expect(defaultPaid("cod")).toBe(false);
  });
});

describe("what stops the order", () => {
  it("accepts a complete order", () => {
    expect(draftProblems(draft(), NOW, EARLIEST)).toEqual({});
  });

  it("needs items with whole quantities and prices", () => {
    expect(draftProblems(draft({ lines: [] }), NOW, EARLIEST)).toEqual({ items: "noItems" });
    expect(draftProblems(draft({ lines: [line({ qty: "0", unitPrice: "6.000" })] }), NOW, EARLIEST)).toEqual({
      "items.0.qty": "qty",
      "items.0.unitPrice": "price",
    });
  });

  it("needs the buyer's name, an address line, and a phone the courier can call", () => {
    expect(draftProblems(draft({ buyerName: " ", line1: "" }), NOW, EARLIEST)).toEqual({
      "buyer.name": "required",
      "shippingAddress.line1": "required",
    });
    expect(draftProblems(draft({ buyerPhone: "" }), NOW, EARLIEST)).toEqual({ "shippingAddress.phone": "phoneNeeded" });
    expect(draftProblems(draft({ buyerPhone: "", recipientPhone: "0812 3456 7890" }), NOW, EARLIEST)).toEqual({});
    expect(draftProblems(draft({ buyerPhone: "abc" }), NOW, EARLIEST)).toEqual({ "buyer.phone": "phone" });
    // picked up: no address, no phone needed
    expect(draftProblems(draft({ shipTo: "pickup", line1: "", buyerPhone: "" }), NOW, EARLIEST)).toEqual({});
  });

  it("keeps the discount within the subtotal and money whole", () => {
    expect(draftProblems(draft({ discount: "120001" }), NOW, EARLIEST)).toEqual({ discount: "discountTooBig" });
    expect(draftProblems(draft({ discount: "120000" }), NOW, EARLIEST)).toEqual({});
    expect(draftProblems(draft({ discount: "1.000", shippingFee: "-1" }), NOW, EARLIEST)).toEqual({
      discount: "money",
      shippingFee: "money",
    });
  });

  it("records an order time from 90 days ago up to now", () => {
    expect(draftProblems(draft({ orderedAt: "2026-10-06T10:01" }), NOW, EARLIEST)).toEqual({
      orderedAt: "orderedAtRange",
    });
    expect(draftProblems(draft({ orderedAt: "2026-07-08T09:59" }), NOW, EARLIEST)).toEqual({
      orderedAt: "orderedAtRange",
    });
    expect(draftProblems(draft({ orderedAt: "2026-08-01T08:00" }), NOW, EARLIEST)).toEqual({});
  });
});

describe("the request", () => {
  it("sends a delivery with what was typed, prices as agreed, and trimmed text", () => {
    const body = manualOrderBody(
      draft({
        storeId: "S1",
        recipientName: " Rina ",
        city: "Kota Bandung",
        province: "Jawa Barat",
        shippingProvider: "J&T Express",
        shippingFee: "12000",
        discount: "",
        internalNote: "  bungkus kado ",
      }),
      "Asia/Jakarta",
    );
    expect(body).toEqual({
      storeId: "S1",
      buyer: { name: "Dewi Anggraini", phone: "081234567801" },
      shippingAddress: { line1: "Jl. Melati No. 5", name: "Rina", city: "Kota Bandung", province: "Jawa Barat" },
      items: [{ variantId: shirt.variantId, qty: 2, unitPrice: 60_000 }],
      shippingFee: 12_000,
      discount: 0,
      paymentMethod: "transfer",
      paid: false,
      shippingProvider: "J&T Express",
      internalNote: "bungkus kado",
    });
  });

  it("sends a pickup without an address, courier, or shipping fee, and COD without paid", () => {
    const body = manualOrderBody(
      draft({ shipTo: "pickup", shippingFee: "12000", shippingProvider: "JNE", paymentMethod: "cod", paid: true }),
      "Asia/Jakarta",
    );
    expect(body.shippingAddress).toBeNull();
    expect(body.shippingFee).toBe(0);
    expect(body.shippingProvider).toBeUndefined();
    expect(body).not.toHaveProperty("paid");
  });

  it("reads the order time on the business's clock", () => {
    expect(zonedToIso("2026-10-05T14:30", "Asia/Jakarta")).toBe("2026-10-05T07:30:00.000Z");
    expect(zonedToIso("2026-10-05T14:30", "Asia/Makassar")).toBe("2026-10-05T06:30:00.000Z");
    expect(zonedToIso("2026-10-05T01:00", "Asia/Jayapura")).toBe("2026-10-04T16:00:00.000Z");
    // just after a clock change the offset of the first guess is the old one; the second pass corrects it
    expect(zonedToIso("2026-03-08T03:30", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    expect(manualOrderBody(draft({ orderedAt: "2026-10-05T14:30" }), "Asia/Jakarta").orderedAt).toBe(
      "2026-10-05T07:30:00.000Z",
    );
    expect(localInput(new Date("2026-10-05T23:30:00Z"), "Asia/Jakarta")).toBe("2026-10-06T06:30");
  });
});
