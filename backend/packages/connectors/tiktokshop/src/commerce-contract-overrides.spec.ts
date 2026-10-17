import { describe, expect, it } from "vitest";
import { TIKTOK_COMMERCE_OPERATIONS } from "./commerce.js";
import { assertTiktokReadOutcome, tiktokCommerceBody, tiktokCommerceQuery } from "./commerce-contract-overrides.js";
import { TIKTOK_MAPPING_GET_PATH } from "./get-json-body.js";

const mapper = TIKTOK_COMMERCE_OPERATIONS.find((operation) => operation.path === TIKTOK_MAPPING_GET_PATH)!;
describe("reviewed commerce contract supplements", () => {
  it("classifies reviewed POST retrievals as reads without reclassifying commands", () => {
    for (const id of [
      "650a9191c16ffe02b8eec161",
      "69dde24cf76068049e2730b8",
      "6a296867f76068049e634aa4",
      "67287d619ba2a002fe590322",
      "66716aa19a01ec02e5b90513",
    ])
      expect(TIKTOK_COMMERCE_OPERATIONS.find((operation) => operation.id === `tiktok_${id}`)).toMatchObject({
        method: "POST",
        write: false,
        available: true,
      });
    for (const id of ["68c8c9ec5c61db0495090a2c", "69252a78aa386e04d7f2533e", "68d4e70b174916049db1c6c3"])
      expect(TIKTOK_COMMERCE_OPERATIONS.find((operation) => operation.id === `tiktok_${id}`)).toMatchObject({
        method: "POST",
        write: true,
      });
  });
  it("retains numeric int64 wire IDs exactly without permitting arbitrary JSON fragments", () => {
    expect(JSON.stringify(tiktokCommerceBody(mapper, { body: { toko_pids: ["9223372036854775807", "42"] } }))).toBe(
      '{"toko_pids":[9223372036854775807,42]}',
    );
    for (const id of ["9223372036854775808", "42.1", "1e4", "0", "01", '1],"secret":1', 42])
      expect(() => tiktokCommerceBody(mapper, { body: { toko_pids: [id] } })).toThrowError();
  });
  it("treats a documented nested mapping error as a rejection rather than a successful read", () => {
    expect(() =>
      assertTiktokReadOutcome(mapper, { error: { code: 1, message: "private marketplace detail" } }),
    ).toThrowError();
    expect(() => assertTiktokReadOutcome(mapper, { error: { code: 0 }, product: [] })).not.toThrowError();
    expect(() => assertTiktokReadOutcome(mapper, { product: [] })).not.toThrowError();
    expect(() => assertTiktokReadOutcome(mapper, { error: { code: "0" } })).toThrowError();
  });
  it("includes all official message enums and keeps unspecified scopes blocked", () => {
    const send = TIKTOK_COMMERCE_OPERATIONS.find((operation) => operation.id === "tiktok_6a1ff121795c140490537a5c")!;
    expect(send.fields.find((field) => field.name === "body.type")?.options).toEqual([
      "TEXT",
      "IMAGE",
      "VIDEO",
      "PRODUCT_CARD",
      "ORDER_CARD",
      "RETURN_REFUND_CARD",
      "COUPON_CARD",
      "LOGISTICS_CARD",
    ]);
    for (const id of [
      "6ad07b7b26401b04cdc8c13c",
      "6aba1036abf7b104cb3c1c27",
      "6aba10380c118504c745cbc1",
      "6aba32215fe27304c71128cd",
    ])
      expect(TIKTOK_COMMERCE_OPERATIONS.find((operation) => operation.id === `tiktok_${id}`)).toMatchObject({
        available: false,
        scopes: [],
      });
  });
  it("matches each official array query encoding and prevents CSV separator injection", () => {
    const get = (path: string) => TIKTOK_COMMERCE_OPERATIONS.find((operation) => operation.path === path)!;
    expect(
      tiktokCommerceQuery(get("/order/202507/orders"), "ids", ["9223372036854775806", "9223372036854775807"]),
    ).toBe("9223372036854775806,9223372036854775807");
    expect(
      tiktokCommerceQuery(get("/analytics/202609/shop_videos/batch_performance"), "video_ids", ["9223372036854775807"]),
    ).toBe("[9223372036854775807]");
    expect(() => tiktokCommerceQuery(get("/order/202507/orders"), "ids", ["42,99"])).toThrowError();
    expect(() => tiktokCommerceQuery(get("/order/202507/orders"), "unreviewed", ["42"])).toThrowError();
    expect(() =>
      tiktokCommerceQuery(get("/analytics/202609/shop_videos/batch_performance"), "video_ids", [9223372036854776000]),
    ).toThrowError();
  });
});
