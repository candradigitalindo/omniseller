import { describe, expect, it } from "vitest";
import {
  answerWindow,
  canReceive,
  fileToBase64,
  receiptDefaults,
  receiptLineProblem,
  returnNoticeHref,
  returnTabOf,
  windowTone,
} from "./return-meta";

const HOUR = 3_600_000;

describe("return rules", () => {
  it("reads the tab from the URL, returns by default", () => {
    expect(returnTabOf("rto")).toBe("rto");
    expect(returnTabOf("cancellations")).toBe("cancellations");
    expect(returnTabOf(null)).toBe("returns");
    expect(returnTabOf("orders")).toBe("returns");
  });

  it("counts the answer window only while the seller is awaited", () => {
    const now = Date.parse("2026-10-05T00:00:00Z");
    expect(answerWindow({ awaitingDecision: true, respondByAt: "2026-10-05T05:00:00Z" }, now)).toBe(5 * HOUR);
    expect(answerWindow({ awaitingDecision: false, respondByAt: "2026-10-05T05:00:00Z" }, now)).toBeNull();
    expect(answerWindow({ awaitingDecision: true, respondByAt: null }, now)).toBeNull();
  });

  it("turns the deadline red under 12 hours and yellow under a day", () => {
    expect(windowTone(-HOUR)).toBe("danger");
    expect(windowTone(11 * HOUR)).toBe("danger");
    expect(windowTone(20 * HOUR)).toBe("warning");
    expect(windowTone(30 * HOUR)).toBe("success");
  });

  it("receives goods once, only when they travel back", () => {
    expect(canReceive({ goodsReturn: true, receivedAt: null, status: "in_transit" })).toBe(true);
    expect(canReceive({ goodsReturn: true, receivedAt: "2026-10-05T00:00:00Z", status: "in_transit" })).toBe(false);
    expect(canReceive({ goodsReturn: false, receivedAt: null, status: "accepted" })).toBe(false);
    expect(canReceive({ goodsReturn: true, receivedAt: null, status: "rejected" })).toBe(false);
  });

  it("checks a receipt line like the api", () => {
    const [line] = receiptDefaults([{ id: "i1", qty: 3 }]);
    expect(line).toEqual({ returnItemId: "i1", sellable: 3, damaged: 0, missing: 0 });
    expect(receiptLineProblem(line!, { qty: 3, mapped: true })).toBeNull();
    expect(receiptLineProblem({ ...line!, damaged: 1 }, { qty: 3, mapped: true })).toBe("total");
    expect(receiptLineProblem(line!, { qty: 3, mapped: false })).toBe("unmapped");
    expect(receiptLineProblem({ ...line!, sellable: 0, missing: 3 }, { qty: 3, mapped: false })).toBeNull();
  });

  it("encodes a photo as plain base64", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x41]);
    expect(await fileToBase64(new Blob([bytes]))).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("leads a notification to its one request, else to its list", () => {
    expect(returnNoticeHref("return.new", { returnIds: ["01J1"] })).toBe("/retur?id=01J1");
    expect(returnNoticeHref("return.due_soon", { returnIds: ["a", "b"] })).toBe("/retur?awaiting=true");
    expect(returnNoticeHref("return.parcel_back", { count: 4 })).toBe("/retur?tab=rto&receive=true");
  });
});
