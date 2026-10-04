import { describe, expect, it } from "vitest";
import type { ReturnDecisionOption } from "../../db/schema";
import {
  itemsChanged,
  matchItems,
  nextStatus,
  type OrderLine,
  receiptProblems,
  responseProblems,
  rtoItems,
} from "./return-plan";

const line = (over: Partial<OrderLine> & { id: string }): OrderLine => ({
  externalProductId: "1750000001",
  externalSkuId: "2100000001",
  skuSnapshot: "KAOS-HTM-M",
  titleSnapshot: "Kaos Polos",
  qty: 2,
  cancelledQty: 0,
  shippedQty: 2,
  returnedQty: 0,
  ...over,
});

const item = (over: Partial<Parameters<typeof matchItems>[1][number]> = {}) => ({
  externalItemId: "1750000001",
  externalVariantId: "2100000001",
  quantity: 1,
  sku: null,
  title: null,
  refundAmount: null,
  ...over,
});

describe("nextStatus (backend doc 8.26)", () => {
  it("follows the marketplace between open statuses, both ways", () => {
    expect(nextStatus("requested", "accepted")).toBe("accepted");
    expect(nextStatus("in_transit", "accepted")).toBe("accepted");
    expect(nextStatus("rejected", "disputed")).toBe("disputed");
    expect(nextStatus("disputed", "refunded")).toBe("refunded");
    expect(nextStatus("accepted", "accepted")).toBeNull();
  });

  it("keeps a final status unless the request opens again", () => {
    expect(nextStatus("refunded", "closed")).toBeNull();
    expect(nextStatus("cancelled", "accepted")).toBeNull();
    expect(nextStatus("closed", "requested")).toBe("requested");
    expect(nextStatus("cancelled", "requested")).toBe("requested");
  });
});

describe("matchItems", () => {
  it("matches by item and variant, filling promotion-group lines in order and splitting the refund", () => {
    const lines = [line({ id: "L1", qty: 1 }), line({ id: "L2", qty: 2 }), line({ id: "L3", externalSkuId: "" })];
    const out = matchItems(lines, [item({ quantity: 3, refundAmount: 90_000, sku: "S", title: "T" })]);
    expect(out).toEqual([
      {
        orderItemId: "L1",
        externalItemId: "1750000001",
        externalVariantId: "2100000001",
        sku: "S",
        title: "T",
        qty: 1,
        refundAmount: 30_000,
      },
      {
        orderItemId: "L2",
        externalItemId: "1750000001",
        externalVariantId: "2100000001",
        sku: "S",
        title: "T",
        qty: 2,
        refundAmount: 60_000,
      },
    ]);
  });

  it("keeps units no line can take, and leaves cancelled units out of a line's room", () => {
    const lines = [line({ id: "L1", qty: 2, cancelledQty: 1 })];
    const out = matchItems(lines, [item({ quantity: 3, refundAmount: 100 })]);
    expect(out.map((o) => [o.orderItemId, o.qty, o.refundAmount])).toEqual([
      ["L1", 1, 33],
      [null, 2, 67],
    ]);
    // the order line's names fill in what the request leaves out
    expect(out[0]).toMatchObject({ sku: "KAOS-HTM-M", title: "Kaos Polos" });
  });

  it("matches the SKU alone when the marketplace names no item (TikTok Shop), and items without variants by item", () => {
    const tiktok = [line({ id: "T1", externalProductId: "172900", externalSkuId: "1729000000000000001" })];
    expect(matchItems(tiktok, [item({ externalItemId: "", externalVariantId: "1729000000000000001" })])).toMatchObject([
      { orderItemId: "T1", externalItemId: "172900" },
    ]);
    const plain = [
      line({ id: "P1", externalProductId: "9", externalSkuId: "" }),
      line({ id: "P2", externalSkuId: "" }),
    ];
    expect(matchItems(plain, [item({ externalVariantId: "" })]).map((o) => o.orderItemId)).toEqual(["P2"]);
  });

  it("adds up two request items on one line", () => {
    const out = matchItems(
      [line({ id: "L1", qty: 5 })],
      [item({ quantity: 1, refundAmount: 10 }), item({ quantity: 2, refundAmount: null })],
    );
    expect(out).toEqual([expect.objectContaining({ orderItemId: "L1", qty: 3, refundAmount: 10 })]);
    expect(matchItems([], [item({ quantity: 0 })])).toEqual([]);
  });
});

describe("rtoItems", () => {
  it("expects back what each line shipped and has not returned", () => {
    const out = rtoItems([
      line({ id: "L1", shippedQty: 2, returnedQty: 1 }),
      line({ id: "L2", shippedQty: 0 }),
      line({ id: "L4", shippedQty: 2, returnedQty: 2 }),
      line({ id: "L3", shippedQty: 3, externalProductId: null, externalSkuId: null, skuSnapshot: "" }),
    ]);
    expect(out).toEqual([
      {
        orderItemId: "L1",
        externalItemId: "1750000001",
        externalVariantId: "2100000001",
        sku: "KAOS-HTM-M",
        title: "Kaos Polos",
        qty: 1,
        refundAmount: null,
      },
      {
        orderItemId: "L3",
        externalItemId: "",
        externalVariantId: "",
        sku: null,
        title: "Kaos Polos",
        qty: 3,
        refundAmount: null,
      },
    ]);
  });
});

describe("itemsChanged", () => {
  it("compares what the items hold, in any order", () => {
    const a = { orderItemId: "L1", externalItemId: "1", externalVariantId: "2", qty: 1 };
    const b = { orderItemId: null, externalItemId: "1", externalVariantId: "3", qty: 2 };
    expect(itemsChanged([a, b], [b, a])).toBe(false);
    expect(itemsChanged([a], [{ ...a, qty: 2 }])).toBe(true);
    expect(itemsChanged([a], [a, b])).toBe(true);
  });
});

const decisions: ReturnDecisionOption[] = [
  { code: "confirm", action: "accept", label: "Setujui", reasons: [], needsEmail: false },
  {
    code: "dispute",
    action: "reject",
    label: "Sanggah",
    needsEmail: true,
    reasons: [
      {
        code: "47",
        label: "Rusak",
        evidence: [
          { module: 1, requirement: "Video membuka paket", required: true },
          { module: 2, requirement: "Foto barang", required: false },
        ],
      },
      { code: "44", label: "Tidak sepakat", evidence: [] },
    ],
  },
  { code: "REJECT_REQUEST_CANCEL", action: "reject", label: "Tolak", reasons: [], needsEmail: false },
];

describe("responseProblems", () => {
  const input = (over: Partial<Parameters<typeof responseProblems>[1]> = {}) => ({
    decision: "dispute",
    reason: "47",
    comment: null,
    evidence: [{ fileId: "F1", module: 1 }],
    email: "a@b.id",
    ...over,
  });
  const uploaded = new Set(["F1", "F2"]);

  it("accepts a complete decision", () => {
    expect(responseProblems(decisions, input(), uploaded)).toEqual([]);
    expect(responseProblems(decisions, input({ decision: "confirm", reason: null, email: null }), uploaded)).toEqual(
      [],
    );
    expect(
      responseProblems(decisions, input({ decision: "REJECT_REQUEST_CANCEL", reason: null, evidence: [] }), uploaded),
    ).toEqual([]);
  });

  it("refuses decisions the marketplace does not offer now", () => {
    expect(responseProblems(decisions, input({ decision: "APPROVE_RETURN" }), uploaded)).toEqual([
      { path: "decision", message: "Keputusan ini tidak tersedia untuk pengajuan ini sekarang." },
    ]);
  });

  it("needs a reason from the list, the contact email, and photos for required evidence", () => {
    expect(responseProblems(decisions, input({ reason: null, email: null, evidence: [] }), uploaded)).toEqual([
      { path: "reason", message: "Pilih alasan penolakan." },
      { path: "email", message: "Email kontak wajib untuk sanggahan ke marketplace." },
    ]);
    expect(responseProblems(decisions, input({ reason: "13" }), uploaded)).toEqual([
      { path: "reason", message: "Alasan ini tidak tersedia untuk pengajuan ini." },
    ]);
    expect(responseProblems(decisions, input({ evidence: [{ fileId: "F2", module: 2 }] }), uploaded)).toEqual([
      { path: "evidence", message: "Foto wajib: Video membuka paket." },
    ]);
  });

  it("takes only the request's own photos, each for one of the reason's evidence modules, nine at most", () => {
    expect(
      responseProblems(
        decisions,
        input({
          evidence: [
            { fileId: "F1", module: 1 },
            { fileId: "OTHER", module: 1 },
            { fileId: "F2", module: 7 },
          ],
        }),
        uploaded,
      ),
    ).toEqual([
      { path: "evidence.1.fileId", message: "Foto tidak ditemukan pada pengajuan ini." },
      { path: "evidence.2.module", message: "Pilih bukti yang diminta untuk foto ini." },
    ]);
    const ten = Array.from({ length: 10 }, () => ({ fileId: "F1", module: null }));
    expect(responseProblems(decisions, input({ reason: "44", evidence: ten }), uploaded)).toEqual([
      { path: "evidence", message: "Paling banyak 9 foto." },
    ]);
  });
});

describe("receiptProblems", () => {
  const items = [
    { id: "R1", qty: 2, orderItemId: "L1", variantId: "V1" },
    { id: "R2", qty: 1, orderItemId: null, variantId: null },
  ];

  it("accepts every item counted once, adding up, stock only for lines with a product", () => {
    expect(
      receiptProblems(items, [
        { returnItemId: "R1", sellable: 1, damaged: 1, missing: 0 },
        { returnItemId: "R2", sellable: 0, damaged: 0, missing: 1 },
      ]),
    ).toEqual([]);
  });

  it("names what is wrong", () => {
    expect(
      receiptProblems(items, [
        { returnItemId: "R1", sellable: 2, damaged: 1, missing: 0 },
        { returnItemId: "R1", sellable: 2, damaged: 0, missing: 0 },
        { returnItemId: "R2", sellable: 1, damaged: 0, missing: 0 },
        { returnItemId: "X", sellable: 1, damaged: 0, missing: 0 },
      ]),
    ).toEqual([
      { path: "items.0", message: "Jumlah layak jual, rusak, dan tidak diterima harus 2." },
      { path: "items.1.returnItemId", message: "Barang ini disebut dua kali." },
      {
        path: "items.2",
        message: "SKU ini belum terhubung ke produk OmniSeller. Hubungkan dulu, atau catat sebagai tidak diterima.",
      },
      { path: "items.3.returnItemId", message: "Barang ini bukan bagian dari pengajuan." },
    ]);
    // fewer units than the request holds, and damaged units of a line without a product
    expect(
      receiptProblems(items, [
        { returnItemId: "R1", sellable: 1, damaged: 0, missing: 0 },
        { returnItemId: "R2", sellable: 0, damaged: 1, missing: 0 },
      ]),
    ).toEqual([
      { path: "items.0", message: "Jumlah layak jual, rusak, dan tidak diterima harus 2." },
      {
        path: "items.1",
        message: "SKU ini belum terhubung ke produk OmniSeller. Hubungkan dulu, atau catat sebagai tidak diterima.",
      },
    ]);
    expect(receiptProblems(items, [{ returnItemId: "R2", sellable: 0, damaged: 0, missing: 1 }])).toEqual([
      { path: "items", message: "Kondisi barang R1 belum diisi." },
    ]);
  });
});
