import { describe, expect, it } from "vitest";
import type { Permission } from "@/lib/session";
import { JKT, movement, SBY } from "./fixtures";
import {
  actorKind,
  availableSeries,
  changes,
  documentHref,
  type Movement,
  movementTypeOf,
  noteFor,
  pointAt,
  signed,
  sparkGeometry,
} from "./history-meta";

const holding =
  (...perms: Permission[]) =>
  (p: Permission) =>
    perms.includes(p);

describe("the stock card", () => {
  it("reads only known movement types from the URL", () => {
    expect(movementTypeOf("order_ship")).toBe("order_ship");
    expect(movementTypeOf("migration_initial")).toBe("migration_initial");
    expect(movementTypeOf("ship")).toBeNull();
    expect(movementTypeOf(null)).toBeNull();
  });

  it("lists the parts a movement changed, in a fixed order, without the ones it left alone", () => {
    expect(changes(movement({ onHandDelta: -3, reservedDelta: -3 }))).toEqual([
      { part: "onHand", delta: -3 },
      { part: "reserved", delta: -3 },
    ]);
    expect(changes(movement({ bufferDelta: 2, damagedDelta: 1 }))).toEqual([
      { part: "damaged", delta: 1 },
      { part: "buffer", delta: 2 },
    ]);
    expect(changes(movement({}))).toEqual([]);
  });

  it("signs a change", () => {
    expect([signed(2), signed(-3), signed(0)]).toEqual(["+2", "-3", "0"]);
  });

  it("names who moved the stock", () => {
    expect(actorKind(null, "ME")).toBe("system");
    expect(actorKind("ME", "ME")).toBe("you");
    expect(actorKind("OTHER", "ME")).toBe("other");
  });

  it("draws one warehouse, oldest first", () => {
    const rows = [
      movement({ id: "3", availableAfter: 7, createdAt: "2026-10-06T03:00:00.000Z" }),
      movement({ id: "2", warehouseId: SBY, availableAfter: 50, createdAt: "2026-10-05T03:00:00.000Z" }),
      movement({ id: "1", availableAfter: 10, createdAt: "2026-10-04T03:00:00.000Z" }),
    ];
    expect(availableSeries(rows, JKT)).toEqual([
      { at: "2026-10-04T03:00:00.000Z", value: 10 },
      { at: "2026-10-06T03:00:00.000Z", value: 7 },
    ]);
    // the loaded movements are not reordered
    expect(rows.map((r) => r.id)).toEqual(["3", "2", "1"]);
  });

  it("links a document only for those who may open it", () => {
    const doc = (type: NonNullable<Movement["document"]>["type"]) => ({ type, id: "01JDOC", number: "X-1" });
    const all = holding("order:read", "inventory:count", "inventory:transfer");
    expect(documentHref(doc("order"), all)).toBe("/pesanan?id=01JDOC");
    expect(documentHref(doc("return"), all)).toBe("/retur?id=01JDOC");
    expect(documentHref(doc("stock_count"), all)).toBe("/stok/opname/01JDOC");
    expect(documentHref(doc("stock_transfer"), all)).toBe("/stok/transfer?id=01JDOC");
    const none = holding("inventory:read");
    expect(documentHref(doc("order"), none)).toBeNull();
    expect(documentHref(doc("return"), none)).toBeNull();
    expect(documentHref(doc("stock_count"), none)).toBeNull();
    expect(documentHref(doc("stock_transfer"), none)).toBeNull();
  });

  it("leaves out notes that only repeat the document", () => {
    const transfer = { type: "stock_transfer" as const, id: "01JDOC", number: "TF-2610-0001" };
    expect(noteFor({ note: "Transfer TF-2610-0001", document: transfer })).toBeNull();
    expect(noteFor({ note: "Transfer TF-2610-0001 dibatalkan", document: transfer })).toBeNull();
    expect(noteFor({ note: "Satu kardus basah", document: transfer })).toBe("Satu kardus basah");
    expect(noteFor({ note: "Stok fisik tercatat kurang 1 saat dikirim", document: null })).toBe(
      "Stok fisik tercatat kurang 1 saat dikirim",
    );
    expect(noteFor({ note: null, document: transfer })).toBeNull();
    expect(noteFor({ note: "", document: null })).toBeNull();
  });
});

describe("the small line", () => {
  it("gives every movement a step of the same width, holding its value across it", () => {
    const g = sparkGeometry([{ value: 0 }, { value: 10 }, { value: 5 }], 300, 64);
    expect(g.band).toBe(100);
    // 0 at the bottom with 4 units of air, 10 at the top with 4 units of air
    expect(g.ys).toEqual([60, 4, 32]);
    expect(g.zeroY).toBe(60);
    expect(g.d).toBe("M0,60H100V4H200V32H300");
  });

  it("keeps zero inside the box when stock went under it, and draws stock that stayed at zero along the bottom", () => {
    const under = sparkGeometry([{ value: 2 }, { value: -2 }], 100, 64);
    expect(under.ys).toEqual([4, 60]);
    expect(under.zeroY).toBe(32);
    expect(sparkGeometry([{ value: 0 }, { value: 0 }], 100, 64).ys).toEqual([60, 60]);
  });

  it("finds the movement whose step is under the pointer, the last one included", () => {
    expect(pointAt(100, 3, -5)).toBe(0);
    expect(pointAt(100, 3, 0)).toBe(0);
    expect(pointAt(100, 3, 99.9)).toBe(0);
    expect(pointAt(100, 3, 100)).toBe(1);
    expect(pointAt(100, 3, 250)).toBe(2);
    expect(pointAt(100, 3, 300)).toBe(2);
    expect(pointAt(100, 3, 1000)).toBe(2);
  });
});
