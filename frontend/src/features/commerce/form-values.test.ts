import { describe, expect, it } from "vitest";
import type { CommerceField } from "./contracts";
import { commerceInput, commerceReview } from "./form-values";

const field = (name: string, type: CommerceField["type"], extra: Partial<CommerceField> = {}): CommerceField => ({
  name,
  type,
  label: name,
  required: true,
  ...extra,
});

describe("commerce official form values", () => {
  it("keeps large identifiers exact, includes false, and ignores undeclared values", () => {
    const fields = [
      field("path.product_id", "string"),
      field("body.active", "boolean"),
      field("query.page_size", "integer", { minimum: 1, maximum: 100 }),
      field("query.page_token", "string", { required: false }),
    ];
    expect(
      commerceInput(fields, {
        "path.product_id": "9007199254740993",
        "body.active": false,
        "query.page_size": "20",
        "query.page_token": "",
        "body.access_token": "never-send",
      }),
    ).toEqual({
      input: { path: { product_id: "9007199254740993" }, body: { active: false }, query: { page_size: 20 } },
      issues: [],
    });
  });
  it("validates nested required fields and keeps array cardinality bounds off item numbers", () => {
    const fields = [
      field("body.products", "array", {
        minimum: 1,
        maximum: 2,
        children: [field("id", "string"), field("quantity", "integer", { minimum: 1 })],
      }),
      field("body.amounts", "array", { maximum: 2, itemType: "integer" }),
    ];
    const result = commerceInput(fields, { "body.products": [{ id: "123", quantity: "" }], "body.amounts": ["50000"] });
    expect(result.issues).toEqual([{ path: "body.products.0.quantity", label: "quantity", reason: "required" }]);
    expect(result.input.body?.amounts).toEqual([50000]);
  });
  it("rejects unsafe integers, invalid choices, and out-of-range amounts", () => {
    const result = commerceInput(
      [
        field("body.quantity", "integer"),
        field("query.status", "enum", { options: ["ACTIVE"] }),
        field("body.price", "integer", { minimum: 1 }),
      ],
      { "body.quantity": "9007199254740993", "query.status": "unknown", "body.price": "0" },
    );
    expect(result.issues.map((issue) => issue.reason)).toEqual(["integer", "option", "minimum"]);
  });
  it("converts documented Unix timestamps using the business clock, independently of browser timezone", () => {
    const fields = [field("query.start_time", "integer", { format: "datetime" })];
    const draft = { "query.start_time": "2026-10-17T08:30" };
    expect(commerceInput(fields, draft, "Asia/Jakarta").input.query?.start_time).toBe(
      Date.parse("2026-10-17T01:30:00Z") / 1000,
    );
    expect(commerceInput(fields, draft, "Asia/Jayapura").input.query?.start_time).toBe(
      Date.parse("2026-10-16T23:30:00Z") / 1000,
    );
    expect(commerceInput(fields, { "query.start_time": "invalid" }).issues[0]?.reason).toBe("datetime");
  });
  it("includes the documented empty initial cursor while omitting unrelated optional blanks", () => {
    expect(
      commerceInput(
        [
          field("query.cursor", "string", { allowEmpty: true }),
          field("query.page_token", "string", { required: false }),
        ],
        {},
      ),
    ).toEqual({ input: { query: { cursor: "" } }, issues: [] });
  });
  it("sends only the staged file ID after a completed upload and rejects an unfinished upload", () => {
    const fields = [field("body.data", "file")];
    expect(
      commerceInput(fields, { "body.data": { fileId: "01JFILE0000000000000000001", filename: "foto.png" } }),
    ).toEqual({ input: { body: { data: "01JFILE0000000000000000001" } }, issues: [] });
    expect(commerceInput(fields, { "body.data": { fileId: "", filename: "foto.png" } }).issues[0]?.reason).toBe(
      "required",
    );
  });
  it("keeps documented millisecond timestamps exact and reviews filenames rather than internal file IDs", () => {
    const fields = [
      field("query.time_ge", "integer", { format: "datetime", timestampUnit: "milliseconds" }),
      field("body.data", "file"),
    ];
    const draft = {
      "query.time_ge": "2026-10-17T08:30",
      "body.data": { fileId: "internal-file-id", filename: "foto.png" },
    };
    expect(commerceInput(fields, draft).input.query?.time_ge).toBe(Date.parse("2026-10-17T01:30:00Z"));
    expect(commerceReview(fields, draft, "Asia/Jakarta")).toEqual({
      "query.time_ge": "17 Okt 2026, 08.30",
      "body.data": "foto.png",
    });
  });
  it("does not fabricate nested schemas or send fields outside body/query/path", () => {
    const result = commerceInput([field("body.details", "object"), field("headers.authorization", "string")], {
      "body.details": {},
      "headers.authorization": "private",
    });
    expect(result.issues.map((issue) => issue.reason)).toEqual(["incomplete", "incomplete"]);
    expect(result.input).toEqual({});
  });
});
