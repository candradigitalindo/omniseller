import { type CommerceInput, type CommerceValue, validateCommerceInput } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { validateShopeeCommerceConstraints } from "./commerce-constraints.js";
import { SHOPEE_COMMERCE_CONTRACTS } from "./commerce-contracts.js";

function verify(id: string, input: CommerceInput): void {
  const operationId = `shopee.${id}`;
  const contract = SHOPEE_COMMERCE_CONTRACTS.find((entry) => entry.operation.id === operationId);
  expect(contract?.operation.available).toBe(true);
  validateCommerceInput(contract!.operation, input);
  validateShopeeCommerceConstraints(operationId, input);
}
const bundle = { min_amount: 2, start_time: 1800000000, end_time: 1800003600, name: "Paket", purchase_limit: 0 };

describe("reviewed Shopee conditional schemas", () => {
  const rules: Record<string, CommerceValue>[] = [
    { rule_type: 1, fix_price: 100000 },
    { rule_type: 2, discount_percentage: 10 },
    { rule_type: 3, discount_value: 20000 },
  ];
  it.each(rules)("accepts the selected bundle pricing rule without demanding incompatible alternatives %j", (rule) => {
    expect(() => verify("bundle_deal.add_bundle_deal", { body: { ...bundle, ...rule } })).not.toThrow();
  });

  it("rejects missing bundle values and short date windows before transport", () => {
    expect(() => verify("bundle_deal.add_bundle_deal", { body: { ...bundle, rule_type: 1 } })).toThrow();
    expect(() =>
      verify("bundle_deal.add_bundle_deal", {
        body: { ...bundle, rule_type: 1, fix_price: 100000, additional_tiers: [{ min_amount: 4 }] },
      }),
    ).toThrow();
    expect(() =>
      verify("bundle_deal.add_bundle_deal", {
        body: { ...bundle, rule_type: 1, fix_price: 100000, end_time: bundle.start_time + 3599 },
      }),
    ).toThrow();
  });

  it("accepts a discount batch mixing product and variation prices while preserving exact ID text", () => {
    expect(() =>
      verify("discount.update_discount_item", {
        body: {
          discount_id: "9007199254740993",
          item_list: [
            { item_id: "9007199254740995", item_promotion_price: 10000 },
            {
              item_id: "9007199254740997",
              model_list: [{ model_id: "9007199254740999", model_promotion_price: 9000 }],
            },
          ],
        },
      }),
    ).not.toThrow();
    expect(() =>
      verify("discount.update_discount_item", {
        body: { discount_id: "1", item_list: [{ item_id: "2" }] },
      }),
    ).toThrow();
  });

  it("treats Flash Sale quota as promotion input and rejects mismatched variation branches", () => {
    expect(() =>
      verify("shop_flash_sale.add_shop_flash_sale_items", {
        body: {
          flash_sale_id: "1",
          items: [
            { item_id: "2", purchase_limit: 0, item_input_promo_price: 15000, item_stock: 5 },
            { item_id: "3", purchase_limit: 1, models: [{ model_id: "4", input_promo_price: 14000, stock: 5 }] },
          ],
        },
      }),
    ).not.toThrow();
    expect(() =>
      verify("shop_flash_sale.add_shop_flash_sale_items", {
        body: { flash_sale_id: "1", items: [{ item_id: "2", purchase_limit: 0 }] },
      }),
    ).toThrow();
    expect(() =>
      verify("shop_flash_sale.add_shop_flash_sale_items", {
        body: {
          flash_sale_id: "1",
          items: [
            {
              item_id: "2",
              purchase_limit: 0,
              item_stock: 2,
              models: [{ model_id: "4", input_promo_price: 14000, stock: 5 }],
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("rejects a zero promo quota and unknown stock payloads inside product edits", () => {
    expect(() =>
      verify("shop_flash_sale.add_shop_flash_sale_items", {
        body: {
          flash_sale_id: "1",
          items: [{ item_id: "2", purchase_limit: 0, item_input_promo_price: 15000, item_stock: 0 }],
        },
      }),
    ).toThrow();
    expect(() => verify("product.update_item", { body: { item_id: "1", stock: 100 } })).toThrow();
  });

  it("keeps a product model pre-order false case valid and requires days for true", () => {
    const model = { model_id: "9007199254740993", model_sku: "biru" };
    expect(() =>
      verify("product.update_model", {
        body: { item_id: "1", model: [{ ...model, pre_order: { is_pre_order: false } }] },
      }),
    ).not.toThrow();
    expect(() =>
      verify("product.update_model", {
        body: { item_id: "1", model: [{ ...model, pre_order: { is_pre_order: true } }] },
      }),
    ).toThrow();
  });

  it("checks rich description alternatives without requiring text for an image", () => {
    const rich = (field: Record<string, string | { image_id: string }>): CommerceInput => ({
      body: {
        item_id: "1",
        description_type: "extended",
        description_info: { extended_description: { field_list: [field] } },
      },
    });
    expect(() =>
      verify("product.update_item", rich({ field_type: "image", image_info: { image_id: "id-picture" } })),
    ).not.toThrow();
    expect(() => verify("product.update_item", rich({ field_type: "text" }))).toThrow();
    expect(() => verify("product.update_item", rich({ field_type: "image" }))).toThrow();
  });

  it("requires an Indonesian pharmacist and a free-text reason for the documented rejection option", () => {
    expect(() =>
      verify("order.handle_prescription_check", { body: { order_sn: "order-1", is_approved: true } }),
    ).toThrow();
    expect(() =>
      verify("order.handle_prescription_check", {
        body: { order_sn: "order-1", is_approved: false, pharmacist_name: "Apoteker", reject_reason_code: 5 },
      }),
    ).toThrow();
    expect(() =>
      verify("order.handle_prescription_check", {
        body: {
          order_sn: "order-1",
          is_approved: false,
          pharmacist_name: "Apoteker",
          reject_reason_code: 5,
          free_text: "Resep belum valid",
        },
      }),
    ).not.toThrow();
  });

  it("accepts exactly one reviewed document source and caps the total label copies", () => {
    expect(() =>
      verify("logistics.create_shipping_document_job", {
        body: { shipping_document_type: "THERMAL_UNPACKAGED_LABEL", package_list: ["p1"] },
      }),
    ).not.toThrow();
    expect(() =>
      verify("logistics.create_shipping_document_job", {
        body: {
          shipping_document_type: "THERMAL_UNPACKAGED_LABEL",
          unpackaged_sku_requests: [
            { unpackaged_sku_id: "a", quantity: 301 },
            { unpackaged_sku_id: "b", quantity: 300 },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      verify("logistics.create_shipping_document_job", {
        body: {
          shipping_document_type: "THERMAL_UNPACKAGED_LABEL",
          package_list: ["p1"],
          unpackaged_sku_requests: [{ unpackaged_sku_id: "a", quantity: 1 }],
        },
      }),
    ).toThrow();
  });
});
