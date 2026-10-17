import { describe, expect, it } from "vitest";
import { assertTiktokCommerceOutcome } from "./commerce-outcome.js";
import { TIKTOK_COMMERCE_FAILURE_FIELDS } from "./commerce-outcome-contracts.js";

const invoice = { id: "tiktok_67b542559a140004b343984f", write: true };
const collaboration = { id: "tiktok_68c8c9ddd435d6049a1ebd59", write: true };
describe("reviewed TikTok mutation outcome fields", () => {
  it("detects per-item refusals even with overall HTTP/code success", () => {
    for (const data of [
      { errors: [{ code: 12052032, message: "Every item failed" }] },
      { errors: [{ code: 1 }], success_packages: [{ id: "accepted-one" }] },
    ])
      expect(() => assertTiktokCommerceOutcome(invoice, data)).toThrowError(/commerce_partial_failure/);
    expect(() => assertTiktokCommerceOutcome(invoice, { errors: [] })).not.toThrow();
    expect(() => assertTiktokCommerceOutcome(invoice, {})).not.toThrow();
  });
  it("uses exact reviewed containers rather than unrelated quality or financial fields", () => {
    expect(Object.keys(TIKTOK_COMMERCE_FAILURE_FIELDS)).toHaveLength(31);
    expect(() =>
      assertTiktokCommerceOutcome({ id: invoice.id, write: false }, { errors: [{ code: 1 }] }),
    ).not.toThrow();
    expect(() =>
      assertTiktokCommerceOutcome(
        { id: "tiktok_650a0ee8f1fd3102b91c6493", write: false },
        { check_result: "FAILED", fail_reasons: [{ reason: "listing quality" }] },
      ),
    ).not.toThrow();
    expect(() =>
      assertTiktokCommerceOutcome(
        { id: "unreviewed-diagnostic-operation", write: true },
        { errors: [{ detail: "diagnostic" }], failed_delivery_shipping_fee: "10000" },
      ),
    ).not.toThrow();
  });
  it("recognizes failed target collaboration fields and ignores empty failure lists", () => {
    expect(() =>
      assertTiktokCommerceOutcome(collaboration, {
        update_failed: { remove_product_ids: [] },
        target_collaboration_conflicts: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertTiktokCommerceOutcome(collaboration, { update_failed: { remove_product_ids: ["123"] } }),
    ).toThrowError(/commerce_partial_failure/);
    expect(() =>
      assertTiktokCommerceOutcome(collaboration, { target_collaboration_conflicts: [{ product_id: "123" }] }),
    ).toThrowError(/commerce_partial_failure/);
    expect(() => assertTiktokCommerceOutcome(collaboration, { update_failed: { name: "" } })).toThrowError(
      /commerce_partial_failure/,
    );
  });
  it("distinguishes mapping error code0 from a reported failure", () => {
    const mapping = { id: "tiktok_6a335dc2f180ee049bf09ed6", write: true };
    expect(() => assertTiktokCommerceOutcome(mapping, { error: { code: 0, message: "" }, product: [] })).not.toThrow();
    expect(() => assertTiktokCommerceOutcome(mapping, { error: { code: 105005, message: "refused" } })).toThrowError(
      /commerce_partial_failure/,
    );
    expect(() => assertTiktokCommerceOutcome(mapping, { error: { code: "0" } })).toThrowError(/bad_response/);
  });
  it("refuses malformed failure containers without returning a success", () => {
    for (const data of [{ errors: {} }, { errors: null }, [], "unexpected"])
      expect(() => assertTiktokCommerceOutcome(invoice, data)).toThrowError(/bad_response/);
  });
});
