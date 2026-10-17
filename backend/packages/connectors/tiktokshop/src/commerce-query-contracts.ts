/** Generated from explicit array query examples in all official API versions.
 * Wire encoding is endpoint-specific; JSON arrays and comma-separated lists are not interchangeable.
 */
export const TIKTOK_COMMERCE_QUERY_SERIALIZERS: Readonly<
  Record<string, Readonly<Record<string, "csv" | "json_int64">>>
> = {
  "/product/202407/sizecharts/search": {
    locales: "csv",
  },
  "/product/202405/products/diagnoses": {
    product_ids: "csv",
  },
  "/product/202405/products/seo_words": {
    product_ids: "csv",
  },
  "/product/202405/products/suggestions": {
    product_ids: "csv",
  },
  "/product/202506/images/translation_tasks": {
    translation_task_ids: "csv",
  },
  "/order/202507/orders": {
    ids: "csv",
  },
  "/order/202309/orders": {
    ids: "csv",
  },
  "/fulfillment/202309/orders/split_attributes": {
    order_ids: "csv",
  },
  "/fbt/202602/inbound_orders": {
    order_ids: "csv",
  },
  "/fbt/202409/inbound_orders": {
    ids: "csv",
  },
  "/return_refund/202405/returns/shipping_documents": {
    return_ids: "csv",
  },
  "/return_refund/202601/decision_eligibility": {
    check_decisions: "csv",
  },
  "/return_refund/202602/orders/{order_id}/aftersale_eligibility": {
    request_types: "csv",
  },
  "/return_refund/202512/orders/{order_id}/aftersale_eligibility": {
    request_types: "csv",
  },
  "/return_refund/202606/review_decision": {
    check_decisions: "csv",
  },
  "/finance/202309/withdrawals": {
    types: "csv",
  },
  "/analytics/202509/shop_skus/performance": {
    category_filter: "csv",
    product_ids: "csv",
  },
  "/analytics/202605/shop_products/performance": {
    category_filter: "csv",
  },
  "/analytics/202509/shop_products/performance": {
    category_filter: "csv",
  },
  "/analytics/202609/shop_videos/batch_performance": {
    video_ids: "json_int64",
  },
  "/affiliate_creator/202509/open_collaborations/products": {
    product_ids: "csv",
  },
  "/affiliate_seller/202410/open_collaborations/sample_rules": {
    product_ids: "csv",
  },
  "/affiliate_seller/202608/marketplace_creators/{creator_user_id}": {
    data_groups: "csv",
  },
  "/affiliate_seller/202508/marketplace_creators/{creator_user_id}": {
    data_groups: "csv",
  },
  "/affiliate_seller/202505/marketplace_creators/{creator_user_id}": {
    data_groups: "csv",
  },
  "/affiliate_seller/202406/marketplace_creators/{creator_user_id}": {
    data_groups: "csv",
  },
};
