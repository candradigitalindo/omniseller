/** Generated from all published API versions by tools/generate-tiktok-commerce-contracts.py.
 * authType: 1 seller, 2 creator, 4 partner. Lists preserve metadata, not a claim of sufficient grants.
 */
export interface TiktokRuntimeScopeContract {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  scopes: readonly { name: string; authType: number }[];
  officialUrl: string;
}
export const TIKTOK_RUNTIME_SCOPE_CONTRACTS: readonly TiktokRuntimeScopeContract[] = [
  {
    method: "GET",
    path: "/authorization/202405/category_assets",
    scopes: [
      {
        name: "partner.authorization.info",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-authorized-category-assets-202405",
  },
  {
    method: "GET",
    path: "/authorization/202309/shops",
    scopes: [
      {
        name: "seller.authorization.info",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-authorized-shops-202309",
  },
  {
    method: "GET",
    path: "/event/202309/webhooks",
    scopes: [
      {
        name: "seller.authorization.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-webhooks-202309",
  },
  {
    method: "PUT",
    path: "/event/202309/webhooks",
    scopes: [
      {
        name: "seller.authorization.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-shop-webhook-202309",
  },
  {
    method: "DELETE",
    path: "/event/202309/webhooks",
    scopes: [
      {
        name: "seller.authorization.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/delete-webhook-for-an-event-202309",
  },
  {
    method: "GET",
    path: "/seller/202309/shops",
    scopes: [
      {
        name: "seller.shop.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-active-shops-202309",
  },
  {
    method: "GET",
    path: "/seller/202309/permissions",
    scopes: [
      {
        name: "seller.shop.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-global-product-permission-202309",
  },
  {
    method: "GET",
    path: "/seller/202601/shop_groups",
    scopes: [
      {
        name: "seller.authorization.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-group-and-related-shops-202601",
  },
  {
    method: "GET",
    path: "/product/202312/prerequisites",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/check-listing-prerequisites-202312",
  },
  {
    method: "GET",
    path: "/product/202309/prerequisites",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/check-listing-prerequisites-202309",
  },
  {
    method: "GET",
    path: "/product/202309/categories",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-categories-202309",
  },
  {
    method: "POST",
    path: "/product/202309/categories/recommend",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/recommend-category-202309",
  },
  {
    method: "GET",
    path: "/product/202309/categories/{category_id}/rules",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-category-rules-202309",
  },
  {
    method: "GET",
    path: "/product/202309/categories/{category_id}/attributes",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-category-attributes-202309",
  },
  {
    method: "GET",
    path: "/product/202309/brands",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-brands-202309",
  },
  {
    method: "POST",
    path: "/product/202309/brands",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-custom-brands-202309",
  },
  {
    method: "POST",
    path: "/product/202309/products/listing_check",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
      {
        name: "serller.product.optimize",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/check-product-listing-202309",
  },
  {
    method: "POST",
    path: "/product/202309/images/upload",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-product-image-202309",
  },
  {
    method: "POST",
    path: "/product/202309/files/upload",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-product-file-202309",
  },
  {
    method: "POST",
    path: "/product/202407/sizecharts/search",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-size-charts-202407",
  },
  {
    method: "POST",
    path: "/product/202309/products",
    scopes: [
      {
        name: "seller.product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-product-202309",
  },
  {
    method: "POST",
    path: "/product/202309/products/activate",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/activate-products-202309",
  },
  {
    method: "POST",
    path: "/product/202309/products/deactivate",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/deactivate-products-202309",
  },
  {
    method: "DELETE",
    path: "/product/202309/products",
    scopes: [
      {
        name: "seller.product.delete",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/delete-products-202309",
  },
  {
    method: "POST",
    path: "/product/202309/products/recover",
    scopes: [
      {
        name: "seller.product.delete",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/recover-products-202309",
  },
  {
    method: "GET",
    path: "/product/202309/products/{product_id}",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-product-202309",
  },
  {
    method: "POST",
    path: "/product/202502/products/search",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-products-202502",
  },
  {
    method: "POST",
    path: "/product/202312/products/search",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-products-202312",
  },
  {
    method: "POST",
    path: "/product/202309/products/search",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-products-202309",
  },
  {
    method: "POST",
    path: "/product/202309/products/{product_id}/prices/update",
    scopes: [
      {
        name: "seller.product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-price-202309",
  },
  {
    method: "POST",
    path: "/product/202309/products/{product_id}/inventory/update",
    scopes: [
      {
        name: "seller.product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-inventory-202309",
  },
  {
    method: "POST",
    path: "/product/202309/inventory/search",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/inventory-search-202309",
  },
  {
    method: "POST",
    path: "/product/202411/products/diagnose_optimize",
    scopes: [
      {
        name: "serller.product.optimize",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/diagnose-and-optimize-product-202411",
  },
  {
    method: "GET",
    path: "/product/202405/products/diagnoses",
    scopes: [
      {
        name: "serller.product.optimize",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-product-diagnoses-202405",
  },
  {
    method: "GET",
    path: "/product/202405/products/seo_words",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-products-seo-words-202405",
  },
  {
    method: "GET",
    path: "/product/202405/products/suggestions",
    scopes: [
      {
        name: "serller.product.optimize",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-recommended-product-title-and-description-202405",
  },
  {
    method: "POST",
    path: "/product/202404/images/optimize",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/optimize-images-202404",
  },
  {
    method: "POST",
    path: "/product/202505/images/translation_tasks",
    scopes: [
      {
        name: "serller.product.optimize",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-image-translation-tasks-202505",
  },
  {
    method: "GET",
    path: "/product/202506/images/translation_tasks",
    scopes: [
      {
        name: "serller.product.optimize",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-image-translation-tasks-202506",
  },
  {
    method: "GET",
    path: "/product/202309/global_categories",
    scopes: [
      {
        name: "seller.global_product.category.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-global-categories-202309",
  },
  {
    method: "POST",
    path: "/product/202309/global_categories/recommend",
    scopes: [
      {
        name: "seller.global_product.category.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/recommend-global-categories-202309",
  },
  {
    method: "GET",
    path: "/product/202309/categories/{category_id}/global_rules",
    scopes: [
      {
        name: "seller.global_product.category.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-global-category-rules-202309",
  },
  {
    method: "GET",
    path: "/product/202309/categories/{category_id}/global_attributes",
    scopes: [
      {
        name: "seller.global_product.category.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-global-attributes-202309",
  },
  {
    method: "POST",
    path: "/product/202309/global_products",
    scopes: [
      {
        name: "seller.global_product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-global-product-202309",
  },
  {
    method: "POST",
    path: "/product/202309/global_products/{global_product_id}/publish",
    scopes: [
      {
        name: "seller.global_product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/publish-global-product-202309",
  },
  {
    method: "PUT",
    path: "/product/202309/global_products/{global_product_id}",
    scopes: [
      {
        name: "seller.global_product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/edit-global-product-202309",
  },
  {
    method: "DELETE",
    path: "/product/202309/global_products",
    scopes: [
      {
        name: "seller.global_product.delete",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/delete-global-products-202309",
  },
  {
    method: "GET",
    path: "/product/202309/global_products/{global_product_id}",
    scopes: [
      {
        name: "seller.global_product.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-global-product-202309",
  },
  {
    method: "POST",
    path: "/product/202312/global_products/search",
    scopes: [
      {
        name: "seller.global_product.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-global-products-202312",
  },
  {
    method: "POST",
    path: "/product/202309/global_products/search",
    scopes: [
      {
        name: "seller.global_product.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-global-products-202309",
  },
  {
    method: "POST",
    path: "/product/202309/global_products/{global_product_id}/inventory/update",
    scopes: [
      {
        name: "seller.global_product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-global-inventory-202309",
  },
  {
    method: "POST",
    path: "/product/202409/compliance/manufacturers",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-manufacturer-202409",
  },
  {
    method: "POST",
    path: "/product/202409/compliance/manufacturers/{manufacturer_id}/partial_edit",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/partial-edit-manufacturer-202409",
  },
  {
    method: "POST",
    path: "/product/202501/compliance/manufacturers/search",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-manufacturers-202501",
  },
  {
    method: "POST",
    path: "/product/202409/compliance/manufacturers/search",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-manufacturers-202409",
  },
  {
    method: "POST",
    path: "/product/202409/compliance/responsible_persons",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-responsible-person-202409",
  },
  {
    method: "POST",
    path: "/product/202409/compliance/responsible_persons/{responsible_person_id}/partial_edit",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/partial-edit-responsible-person-202409",
  },
  {
    method: "POST",
    path: "/product/202501/compliance/responsible_persons/search",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-responsible-persons-202501",
  },
  {
    method: "POST",
    path: "/product/202409/compliance/responsible_persons/search",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-responsible-persons-202409",
  },
  {
    method: "POST",
    path: "/product/202407/products/category_upgrade_task",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-category-upgrade-task-202407",
  },
  {
    method: "GET",
    path: "/product/202507/global_listing_rules",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-global-listing-rules-202507",
  },
  {
    method: "POST",
    path: "/product/202507/products/{product_id}/global_replicate",
    scopes: [
      {
        name: "seller.product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/replicate-product-202507",
  },
  {
    method: "GET",
    path: "/product/202507/products/{product_id}/replicated_products",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-global-replicated-products-202507",
  },
  {
    method: "PUT",
    path: "/product/202509/products/{product_id}",
    scopes: [
      {
        name: "seller.product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/edit-product-202509",
  },
  {
    method: "PUT",
    path: "/product/202309/products/{product_id}",
    scopes: [
      {
        name: "seller.product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/edit-product-202309",
  },
  {
    method: "POST",
    path: "/product/202509/products/{product_id}/partial_edit",
    scopes: [
      {
        name: "seller.product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/partial-edit-product-202509",
  },
  {
    method: "POST",
    path: "/product/202309/products/{product_id}/partial_edit",
    scopes: [
      {
        name: "seller.product.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/partial-edit-product-202309",
  },
  {
    method: "PUT",
    path: "/product/202509/global_products/{global_product_id}/partial_edit",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/partial-edit-global-product-202509",
  },
  {
    method: "POST",
    path: "/product/202601/compliance/auditing/research",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-products-for-compliance-auditing-202601",
  },
  {
    method: "POST",
    path: "/product/202602/packages/recommend",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-product-package-recommendations-202602",
  },
  {
    method: "GET",
    path: "/product/202604/opportunities/{opportunity_id}",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-opportunity-detail-202604",
  },
  {
    method: "POST",
    path: "/product/202604/opportunities/query",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/list-opportunities-202604",
  },
  {
    method: "POST",
    path: "/product/202604/opportunities/{opportunity_id}/submit",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/submit-product-via-opportunity-202604",
  },
  {
    method: "GET",
    path: "/product/202604/opportunities/submissions",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-submission-records-202604",
  },
  {
    method: "POST",
    path: "/product/202604/products/gpa_upgrade_task",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-gpa-upgrade-task-202604",
  },
  {
    method: "POST",
    path: "/product/202604/appeals/submit",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/submit-size-chart-appeal-202604",
  },
  {
    method: "POST",
    path: "/product/202606/skpps/search",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/list-product-skpp-statuses-202606",
  },
  {
    method: "GET",
    path: "/product/202606/skpps/{product_id}",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-product-skpp-detail-202606",
  },
  {
    method: "GET",
    path: "/product/202606/skpps/sum",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-skpp-summary-202606",
  },
  {
    method: "POST",
    path: "/product/202608/size_charts",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-size-chart-202608",
  },
  {
    method: "POST",
    path: "/product/202608/size_charts/edit",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/edit-size-chart-202608",
  },
  {
    method: "POST",
    path: "/product/202608/inventory/operation/settings",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-stock-operation-settings-202608",
  },
  {
    method: "POST",
    path: "/product/202604/inventory/operation/settings",
    scopes: [
      {
        name: "seller.product.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-stock-operation-settings-202604",
  },
  {
    method: "POST",
    path: "/product/202609/products/package/predict",
    scopes: [],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/predict-product-package-dimensions-and-weight-202609",
  },
  {
    method: "POST",
    path: "/product/202609/products/properties/recommend",
    scopes: [],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/recommend-required-product-properties-202609",
  },
  {
    method: "POST",
    path: "/product/202609/products/{product_id}/strikethrough_price/submit",
    scopes: [],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/submit-strikethrough-price-202609",
  },
  {
    method: "POST",
    path: "/promotion/202309/activities",
    scopes: [
      {
        name: "seller.promotion.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-promotion-activity-202309",
  },
  {
    method: "PUT",
    path: "/promotion/202309/activities/{activity_id}",
    scopes: [
      {
        name: "seller.promotion.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-promotion-activity-202309",
  },
  {
    method: "POST",
    path: "/promotion/202309/activities/{activity_id}/deactivate",
    scopes: [
      {
        name: "seller.promotion.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/deactivate-activity-202309",
  },
  {
    method: "GET",
    path: "/promotion/202309/activities/{activity_id}",
    scopes: [
      {
        name: "seller.promotion.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-activity-202309",
  },
  {
    method: "POST",
    path: "/promotion/202309/activities/search",
    scopes: [
      {
        name: "seller.promotion.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-promotion-activities-202309",
  },
  {
    method: "PUT",
    path: "/promotion/202309/activities/{activity_id}/products",
    scopes: [
      {
        name: "seller.promotion.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-promotion-activity-products-202309",
  },
  {
    method: "DELETE",
    path: "/promotion/202309/activities/{activity_id}/products",
    scopes: [
      {
        name: "seller.promotion.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/remove-promotion-activity-products-202309",
  },
  {
    method: "GET",
    path: "/promotion/202406/coupons/{coupon_id}",
    scopes: [
      {
        name: "seller.promotion.info",
        authType: 1,
      },
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-coupon-202406",
  },
  {
    method: "POST",
    path: "/promotion/202406/coupons/search",
    scopes: [
      {
        name: "seller.promotion.info",
        authType: 1,
      },
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-coupon-list-202406",
  },
  {
    method: "POST",
    path: "/promotion/202607/activities/{activity_id}/republish",
    scopes: [
      {
        name: "seller.promotion.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/republish-activity-202607",
  },
  {
    method: "POST",
    path: "/order/202309/orders/search",
    scopes: [
      {
        name: "seller.order.info",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-order-list-202309",
  },
  {
    method: "GET",
    path: "/order/202407/orders/{order_id}/price_detail",
    scopes: [
      {
        name: "seller.order.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-order-price-details-202407",
  },
  {
    method: "POST",
    path: "/order/202406/orders/external_orders",
    scopes: [
      {
        name: "seller.order.ext_ref.write.custom",
        authType: 1,
      },
      {
        name: "seller.order.ext_ref.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/add-external-order-references-202406",
  },
  {
    method: "GET",
    path: "/order/202406/orders/{order_id}/external_orders",
    scopes: [
      {
        name: "seller.order.ext_ref.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-external-order-references-202406",
  },
  {
    method: "POST",
    path: "/order/202406/orders/external_order_search",
    scopes: [
      {
        name: "seller.order.ext_ref.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-orders-by-external-order-reference-202406",
  },
  {
    method: "GET",
    path: "/order/202507/orders",
    scopes: [
      {
        name: "seller.order.info",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-order-detail-202507",
  },
  {
    method: "GET",
    path: "/order/202309/orders",
    scopes: [
      {
        name: "seller.order.info",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-order-detail-202309",
  },
  {
    method: "POST",
    path: "/order/202605/orders/blind_box_result/callback",
    scopes: [
      {
        name: "seller.order.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-the-blind-box-opening-results-202605",
  },
  {
    method: "POST",
    path: "/order/202511/orders/blind_box_result/callback",
    scopes: [
      {
        name: "seller.order.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-the-blind-box-opening-results-202511",
  },
  {
    method: "POST",
    path: "/order/202606/pod_details/search",
    scopes: [
      {
        name: "seller.order.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-pod-customization-details-202606",
  },
  {
    method: "GET",
    path: "/fulfillment/202309/orders/split_attributes",
    scopes: [
      {
        name: "seller.fulfillment.package.write",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-order-split-attributes-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/orders/{order_id}/split",
    scopes: [
      {
        name: "seller.fulfillment.package.write",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/confirm-order-split-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/orders/{order_id}/shipping_services/query",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-eligible-shipping-services-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202407/bundles",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-first-mile-bundle-202407",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/packages/search",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-package-202309",
  },
  {
    method: "GET",
    path: "/fulfillment/202309/combinable_packages/search",
    scopes: [
      {
        name: "seller.fulfillment.package.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-combinable-packages-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/packages/combine",
    scopes: [
      {
        name: "seller.fulfillment.package.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/combine-package-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/packages/{package_id}/uncombine",
    scopes: [
      {
        name: "seller.fulfillment.package.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/uncombine-packages-202309",
  },
  {
    method: "GET",
    path: "/fulfillment/202309/packages/{package_id}/handover_time_slots",
    scopes: [
      {
        name: "seller.fulfillment.package.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-package-handover-time-slots-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/packages/{package_id}/ship",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/ship-package-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/packages/ship",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/batch-ship-packages-202309",
  },
  {
    method: "GET",
    path: "/fulfillment/202309/packages/{package_id}/shipping_documents",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-package-shipping-document-202309",
  },
  {
    method: "GET",
    path: "/fulfillment/202309/packages/{package_id}",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-package-detail-202309",
  },
  {
    method: "GET",
    path: "/fulfillment/202309/orders/{order_id}/tracking",
    scopes: [
      {
        name: "seller.logistics",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-order-tracking-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/orders/{order_id}/shipping_info/update",
    scopes: [
      {
        name: "seller.logistics",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-order-shipping-info-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/files/upload",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-proof-of-delivery-file-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/images/upload",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-proof-of-delivery-image-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/packages/deliver",
    scopes: [
      {
        name: "seller.delivery.status.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-package-delivery-status-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202502/invoice/upload",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-invoice-202502",
  },
  {
    method: "GET",
    path: "/fulfillment/202508/tts_tracking_validation",
    scopes: [
      {
        name: "seller.logistics",
        authType: 1,
      },
    ],
    officialUrl:
      "https://partner.tiktokshop.com/docv2/page/check-tiktok-shipping-and-collection-by-tiktok-coverage-202508",
  },
  {
    method: "POST",
    path: "/fulfillment/202510/first_mile_bundle",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-first-mile-bundle-v2-202510",
  },
  {
    method: "POST",
    path: "/fulfillment/202512/packages",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-packages-202512",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/packages",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-packages-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202601/redeem_info/callback",
    scopes: [
      {
        name: "seller.redeem_info.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/submit-redemption-information-202601",
  },
  {
    method: "POST",
    path: "/fulfillment/202606/pod_details/get",
    scopes: [
      {
        name: "seller.redeem_info.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-pod-customization-details-202606",
  },
  {
    method: "POST",
    path: "/fulfillment/202607/orders/customs_info/query",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-order-customs-requirements-202607",
  },
  {
    method: "POST",
    path: "/fulfillment/202607/orders/customs_info/submit",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/submit-customs-clearance-information-202607",
  },
  {
    method: "POST",
    path: "/fulfillment/202609/order/sof/track/update",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/tracking-status-update-202609",
  },
  {
    method: "POST",
    path: "/fulfillment/202610/packages/{package_id}/shipping_info/update",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-package-shipping-info-202610",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/packages/{package_id}/shipping_info/update",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-package-shipping-info-202309",
  },
  {
    method: "POST",
    path: "/fulfillment/202610/orders/{order_id}/packages",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/mark-package-as-shipped-202610",
  },
  {
    method: "POST",
    path: "/fulfillment/202309/orders/{order_id}/packages",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/mark-package-as-shipped-202309",
  },
  {
    method: "GET",
    path: "/fbt/202409/merchants/onboarded_regions",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-fbt-merchant-onboarded-regions-202409",
  },
  {
    method: "GET",
    path: "/fbt/202408/warehouses",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-fbt-warehouse-list-202408",
  },
  {
    method: "POST",
    path: "/fbt/202408/inventory/search",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-fbt-inventory-202408",
  },
  {
    method: "POST",
    path: "/fbt/202410/inventory_records/search",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-fbt-inventory-record-202410",
  },
  {
    method: "GET",
    path: "/fbt/202601/mcf_outbound_orders",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-fbt-mcf-order-status-202601",
  },
  {
    method: "POST",
    path: "/fbt/202601/mcf_outbound_orders/cancel",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/cancel-fbt-mcf-order-202601",
  },
  {
    method: "POST",
    path: "/fbt/202601/mcf/goods/inventory/search",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/query-goods-inventory-for-mcf-202601",
  },
  {
    method: "GET",
    path: "/fbt/202601/merchants/mcf_status",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-fbt-merchant-mcf-status-202601",
  },
  {
    method: "POST",
    path: "/fbt/202602/create_update_inbound_plan",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-or-update-inbound-plan-202602",
  },
  {
    method: "POST",
    path: "/fbt/202602/list_available_inbound_method",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/list-available-inbound-methods-202602",
  },
  {
    method: "POST",
    path: "/fbt/202602/inbound_method_detail",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-inbound-method-detail-202602",
  },
  {
    method: "POST",
    path: "/fbt/202602/inbound_orders/label_print",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/print-inbound-order-labels-202602",
  },
  {
    method: "POST",
    path: "/fbt/202602/inbound_orders/tracking_update",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-inbound-order-tracking-202602",
  },
  {
    method: "POST",
    path: "/fbt/202602/inbound_orders/cancel",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/cancel-inbound-order-202602",
  },
  {
    method: "GET",
    path: "/fbt/202602/inbound_orders",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-fbt-inbound-order-details-202602",
  },
  {
    method: "GET",
    path: "/fbt/202409/inbound_orders",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-fbt-inbound-order-details-202409",
  },
  {
    method: "POST",
    path: "/fbt/202603/confirm_inbound_method",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/confirm-inbound-method-202603",
  },
  {
    method: "POST",
    path: "/fbt/202603/ship_inbound_order",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/ship-inbound-order-202603",
  },
  {
    method: "POST",
    path: "/fbt/202603/goods/update_goods_sku_relation",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-goods-sku-relations-202603",
  },
  {
    method: "POST",
    path: "/fbt/202603/goods/hazmat_and_expiration_info/search",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-goods-hazmat-and-expiration-info-202603",
  },
  {
    method: "POST",
    path: "/fbt/202607/mcf_outbound_orders",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-fbt-mcf-order-202607",
  },
  {
    method: "POST",
    path: "/fbt/202601/mcf_outbound_orders",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-fbt-mcf-order-202601",
  },
  {
    method: "POST",
    path: "/fbt/202607/goods/search",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-goods-info-202607",
  },
  {
    method: "POST",
    path: "/fbt/202409/goods/search",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-goods-info-202409",
  },
  {
    method: "POST",
    path: "/fbt/202607/goods/update_goods_info",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-fbt-goods-info-202607",
  },
  {
    method: "POST",
    path: "/fbt/202603/goods/update_goods_info",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-fbt-goods-info-202603",
  },
  {
    method: "POST",
    path: "/fbt/202607/goods/create_goods",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-fbt-goods-202607",
  },
  {
    method: "POST",
    path: "/fbt/202603/goods/create_goods",
    scopes: [
      {
        name: "seller.fbt.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-fbt-goods-202603",
  },
  {
    method: "GET",
    path: "/logistics/202309/warehouses",
    scopes: [
      {
        name: "seller.logistics",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-warehouse-list-202309",
  },
  {
    method: "GET",
    path: "/logistics/202309/global_warehouses",
    scopes: [
      {
        name: "seller.shop.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-global-seller-warehouses-202309",
  },
  {
    method: "GET",
    path: "/logistics/202309/warehouses/{warehouse_id}/delivery_options",
    scopes: [
      {
        name: "seller.logistics",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-warehouse-delivery-options-202309",
  },
  {
    method: "GET",
    path: "/logistics/202309/delivery_options/{delivery_option_id}/shipping_providers",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.logistics",
        authType: 1,
      },
      {
        name: "seller.fs.order&fufillment.management",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shipping-providers-202309",
  },
  {
    method: "GET",
    path: "/logistics/202510/seller_templates",
    scopes: [
      {
        name: "seller.logistics",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shipping-template-availability-202510",
  },
  {
    method: "GET",
    path: "/logistics/202604/orders/{order_id}/tracking",
    scopes: [
      {
        name: "seller.logistics",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-logistics-tracking-202604",
  },
  {
    method: "GET",
    path: "/logistics/202606/seller_template/template_exist",
    scopes: [
      {
        name: "seller.logistics",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/check-shipping-template-existence-202606",
  },
  {
    method: "GET",
    path: "/return_refund/202309/reject_reasons",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-reject-reasons-202309",
  },
  {
    method: "POST",
    path: "/return_refund/202309/returns/{return_id}/approve",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/approve-return-202309",
  },
  {
    method: "GET",
    path: "/return_refund/202309/returns/{return_id}/records",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-return-records-202309",
  },
  {
    method: "POST",
    path: "/return_refund/202309/cancellations/{cancel_id}/approve",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/approve-cancellation-202309",
  },
  {
    method: "POST",
    path: "/return_refund/202309/cancellations/{cancel_id}/reject",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/reject-cancellation-202309",
  },
  {
    method: "POST",
    path: "/return_refund/202405/returns/shipping_documents",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-return-shipping-information-202405",
  },
  {
    method: "GET",
    path: "/return_refund/202601/decision_eligibility",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-decision-eligibility-202601",
  },
  {
    method: "POST",
    path: "/return_refund/202602/refunds/calculate",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/calculate-refund-202602",
  },
  {
    method: "POST",
    path: "/return_refund/202309/refunds/calculate",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/calculate-refund-202309",
  },
  {
    method: "POST",
    path: "/return_refund/202602/cancellations",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/cancel-order-202602",
  },
  {
    method: "POST",
    path: "/return_refund/202309/cancellations",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/cancel-order-202309",
  },
  {
    method: "POST",
    path: "/return_refund/202602/returns",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-return-202602",
  },
  {
    method: "POST",
    path: "/return_refund/202309/returns",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-return-202309",
  },
  {
    method: "POST",
    path: "/return_refund/202602/cancellations/search",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-cancellations-202602",
  },
  {
    method: "POST",
    path: "/return_refund/202309/cancellations/search",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-cancellations-202309",
  },
  {
    method: "POST",
    path: "/return_refund/202602/returns/search",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-returns-202602",
  },
  {
    method: "POST",
    path: "/return_refund/202309/returns/search",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-returns-202309",
  },
  {
    method: "GET",
    path: "/return_refund/202602/orders/{order_id}/aftersale_eligibility",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-aftersale-eligibility-202602",
  },
  {
    method: "GET",
    path: "/return_refund/202512/orders/{order_id}/aftersale_eligibility",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-aftersale-eligibility-202512",
  },
  {
    method: "GET",
    path: "/return_refund/202309/orders/{order_id}/aftersale_eligibility",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-aftersale-eligibility-202309",
  },
  {
    method: "POST",
    path: "/return_refund/202603/aftersales/search",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-aftersales-requests-202603",
  },
  {
    method: "POST",
    path: "/return_refund/202604/rma/search",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-return-merchandise-authorizations-202604",
  },
  {
    method: "GET",
    path: "/return_refund/202606/review_decision",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-available-review-decisions-202606",
  },
  {
    method: "POST",
    path: "/return_refund/202606/returns/{return_id}/reject",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/reject-return-202606",
  },
  {
    method: "POST",
    path: "/return_refund/202309/returns/{return_id}/reject",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/reject-return-202309",
  },
  {
    method: "POST",
    path: "/return_refund/202609/aftersales/review",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/review-aftersales-requests-202609",
  },
  {
    method: "POST",
    path: "/return_refund/202606/aftersales/review",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/review-aftersales-requests-202606",
  },
  {
    method: "POST",
    path: "/return_refund/202603/aftersales/review",
    scopes: [
      {
        name: "seller.return_refund.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/review-aftersales-requests-202603",
  },
  {
    method: "GET",
    path: "/finance/202309/statements",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-statements-202309",
  },
  {
    method: "GET",
    path: "/finance/202309/withdrawals",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-seller-financial-transactions-202309",
  },
  {
    method: "GET",
    path: "/finance/202501/orders/{order_id}/statement_transactions",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-transactions-by-order-202501",
  },
  {
    method: "GET",
    path: "/finance/202309/orders/{order_id}/statement_transactions",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-transactions-by-order-202309",
  },
  {
    method: "GET",
    path: "/finance/202501/statements/{statement_id}/statement_transactions",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-transactions-by-statement-202501",
  },
  {
    method: "GET",
    path: "/finance/202309/statements/{statement_id}/statement_transactions",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-transactions-by-statement-202309",
  },
  {
    method: "GET",
    path: "/finance/202507/orders/unsettled",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-unsettled-transactions-202507",
  },
  {
    method: "GET",
    path: "/finance/202605/payments",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-payments-202605",
  },
  {
    method: "GET",
    path: "/finance/202309/payments",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-payments-202309",
  },
  {
    method: "GET",
    path: "/finance/202609/account_transactions",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-tradein-account-transactions-202609",
  },
  {
    method: "GET",
    path: "/finance/202609/account_balances",
    scopes: [
      {
        name: "seller.finance.info",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-tradein-supplier-account-balance-202609",
  },
  {
    method: "GET",
    path: "/analytics/202403/videos/performances",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-video-performances-202403",
  },
  {
    method: "GET",
    path: "/analytics/202510/shop/performance/{date}/performance_per_hour",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-performance-per-hour-202510",
  },
  {
    method: "GET",
    path: "/analytics/202510/shop_lives/{live_id}/performance_per_minutes",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-live-minute-performance-202510",
  },
  {
    method: "GET",
    path: "/analytics/202512/shop/{live_id}/products_performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-live-products-performance-list-202512",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop_products/{product_id}/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-product-performance-detail-202509",
  },
  {
    method: "GET",
    path: "/analytics/202405/shop_products/{product_id}/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-product-performance-detail-202405",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop_skus/{sku_id}/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-sku-performance-detail-202509",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop_skus/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-sku-performance-list-202509",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop_videos/{video_id}/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-video-performance-details-202509",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop_videos/{video_id}/products/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-video-product-performance-list-202509",
  },
  {
    method: "GET",
    path: "/analytics/202502/live_rooms/{live_room_id}/view_trend_performances",
    scopes: [
      {
        name: "creator.data.live.read.public",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-live-room-view-trends-202502",
  },
  {
    method: "GET",
    path: "/analytics/202502/live_rooms/{live_room_id}/traffic_performances",
    scopes: [
      {
        name: "creator.data.live.read.public",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-live-room-traffic-performance-202502",
  },
  {
    method: "GET",
    path: "/analytics/202502/live_rooms/{live_room_id}/user_portraits",
    scopes: [
      {
        name: "creator.data.live.read.public",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-live-room-user-portraits-202502",
  },
  {
    method: "GET",
    path: "/analytics/202502/live_rooms/{live_room_id}/product_stats",
    scopes: [
      {
        name: "creator.data.live.read.public",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-live-room-product-stats-202502",
  },
  {
    method: "GET",
    path: "/analytics/202502/live_rooms/{live_room_id}/interactive_trend_performances",
    scopes: [
      {
        name: "creator.data.live.read.public",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-live-room-interactive-trends-202502",
  },
  {
    method: "GET",
    path: "/analytics/202502/live_rooms/{live_room_id}/gmv_trend_performances",
    scopes: [
      {
        name: "creator.data.live.read.public",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-live-room-gmv-and-order-trends-202502",
  },
  {
    method: "GET",
    path: "/analytics/202502/live_rooms/{live_room_id}/core_stats",
    scopes: [
      {
        name: "creator.data.live.read.public",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-live-room-core-stats-202502",
  },
  {
    method: "GET",
    path: "/analytics/202511/products/bestselling",
    scopes: [
      {
        name: "data.bestselling.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-bestselling-products-202511",
  },
  {
    method: "GET",
    path: "/analytics/202511/creators/bestselling",
    scopes: [
      {
        name: "data.bestselling.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-bestselling-creators-202511",
  },
  {
    method: "GET",
    path: "/analytics/202511/videos/bestselling",
    scopes: [
      {
        name: "data.bestselling.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-bestselling-videos-202511",
  },
  {
    method: "GET",
    path: "/analytics/202511/lives/bestselling",
    scopes: [
      {
        name: "data.bestselling.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-bestselling-live-sessions-202511",
  },
  {
    method: "GET",
    path: "/analytics/202605/shop_videos/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-video-performance-list-202605",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop_videos/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-video-performance-list-202509",
  },
  {
    method: "GET",
    path: "/analytics/202605/shop_products/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-product-performance-list-202605",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop_products/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-product-performance-list-202509",
  },
  {
    method: "GET",
    path: "/analytics/202405/shop_products/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-product-performance-list-202405",
  },
  {
    method: "GET",
    path: "/analytics/202606/shop_performances/metrics/{metric_code}/diagnosis",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-sps-metric-diagnosis-202606",
  },
  {
    method: "GET",
    path: "/analytics/202606/shop_performances/metrics/{metric_code}/problem_details",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-sps-metric-problem-details-202606",
  },
  {
    method: "GET",
    path: "/analytics/202606/shop_performances/metrics/{metric_code}/top_items",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-sps-metric-top-items-202606",
  },
  {
    method: "GET",
    path: "/analytics/202606/shop_performances/overview",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-sps-overview-202606",
  },
  {
    method: "GET",
    path: "/analytics/202606/shop_performances/metrics",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-sps-metrics-202606",
  },
  {
    method: "GET",
    path: "/analytics/202609/shop_lives/overview_performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-live-performance-overview-202609",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop_lives/overview_performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-live-performance-overview-202509",
  },
  {
    method: "GET",
    path: "/analytics/202508/shop_lives/overview_performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-live-performance-overview-202508",
  },
  {
    method: "GET",
    path: "/analytics/202609/shop_videos/batch_performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-videos-performance-details-202609",
  },
  {
    method: "GET",
    path: "/analytics/202609/shop_lives/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-live-performance-list-202609",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop_lives/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-live-performance-list-202509",
  },
  {
    method: "GET",
    path: "/analytics/202508/shop_lives/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-live-performance-list-202508",
  },
  {
    method: "GET",
    path: "/analytics/202609/shop/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-performance-202609",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-performance-202509",
  },
  {
    method: "GET",
    path: "/analytics/202405/shop/performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-performance-202405",
  },
  {
    method: "GET",
    path: "/analytics/202609/shop_videos/overview_performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-video-performance-overview-202609",
  },
  {
    method: "GET",
    path: "/analytics/202509/shop_videos/overview_performance",
    scopes: [
      {
        name: "data.shop_analytics.public.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-video-performance-overview-202509",
  },
  {
    method: "POST",
    path: "/customer_service/202309/conversations",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-conversation-202309",
  },
  {
    method: "GET",
    path: "/customer_service/202309/conversations",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-conversations-202309",
  },
  {
    method: "GET",
    path: "/customer_service/202309/conversations/{conversation_id}/messages",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-conversation-messages-202309",
  },
  {
    method: "POST",
    path: "/customer_service/202309/images/upload",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-image-for-buyer-messages-202309",
  },
  {
    method: "POST",
    path: "/customer_service/202309/conversations/{conversation_id}/messages/read",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/mark-buyer-messages-as-read-202309",
  },
  {
    method: "GET",
    path: "/customer_service/202309/agents/settings",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-agent-settings-202309",
  },
  {
    method: "PUT",
    path: "/customer_service/202309/agents/settings",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-agent-settings-202309",
  },
  {
    method: "GET",
    path: "/customer_service/202407/performance",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-customer-service-performance-202407",
  },
  {
    method: "GET",
    path: "/customer_service/202601/conversations/{conversation_id}",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-conversation-202601",
  },
  {
    method: "POST",
    path: "/customer_service/202602/sessions/search",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-sessions-202602",
  },
  {
    method: "POST",
    path: "/customer_service/202605/conversations/{conversation_id}/sessions/{session_id}/end",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/end-session-202605",
  },
  {
    method: "POST",
    path: "/customer_service/202606/conversations/{conversation_id}/messages",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/send-message-202606",
  },
  {
    method: "POST",
    path: "/customer_service/202309/conversations/{conversation_id}/messages",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/send-message-202309",
  },
  {
    method: "GET",
    path: "/customer_engagement/202412/message_templates",
    scopes: [
      {
        name: "seller.customer_engagement.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-message-templates-202412",
  },
  {
    method: "POST",
    path: "/customer_engagement/202412/engagement_tasks",
    scopes: [
      {
        name: "seller.customer_engagement.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-engagement-task-202412",
  },
  {
    method: "POST",
    path: "/customer_engagement/202412/messages",
    scopes: [
      {
        name: "seller.customer_engagement.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/send-engagement-message-202412",
  },
  {
    method: "POST",
    path: "/customer_engagement/202412/performances",
    scopes: [
      {
        name: "seller.customer_engagement.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-engagement-task-performances-202412",
  },
  {
    method: "POST",
    path: "/customer_engagement/202502/engagement_tasks/custom",
    scopes: [
      {
        name: "seller.customer_engagement.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-custom-engagement-task-202502",
  },
  {
    method: "GET",
    path: "/customer_engagement/202502/permissions",
    scopes: [
      {
        name: "seller.customer_engagement.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-engagement-feature-permissions-202502",
  },
  {
    method: "GET",
    path: "/affiliate_creator/202508/profiles",
    scopes: [
      {
        name: "creator.affiliate.info",
        authType: 2,
      },
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-creator-profile-202508",
  },
  {
    method: "GET",
    path: "/affiliate_creator/202405/profiles",
    scopes: [
      {
        name: "creator.affiliate.info",
        authType: 2,
      },
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-creator-profile-202405",
  },
  {
    method: "GET",
    path: "/affiliate_creator/202405/showcases/products",
    scopes: [
      {
        name: "creator.showcase.read",
        authType: 2,
      },
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-showcase-products-202405",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202405/showcases/products/add",
    scopes: [
      {
        name: "creator.showcase.write",
        authType: 2,
      },
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/add-showcase-products-202405",
  },
  {
    method: "DELETE",
    path: "/affiliate_creator/202409/showcases/products",
    scopes: [
      {
        name: "creator.showcase.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/remove-showcase-products-202409",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202409/showcases/products/top",
    scopes: [
      {
        name: "creator.showcase.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/move-showcase-products-to-the-top-202409",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202405/open_collaborations/products/search",
    scopes: [
      {
        name: "creator.affiliate_collaboration.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-open-collaboration-products-202405",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202509/open_collaborations/products",
    scopes: [
      {
        name: "creator.affiliate_collaboration.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-open-collaboration-product-list-by-product-ids-202509",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202405/target_collaborations/search",
    scopes: [
      {
        name: "creator.affiliate_collaboration.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-creator-target-collaborations-202405",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202412/sample_applications/search",
    scopes: [
      {
        name: "creator.affiliate_collaboration.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-creator-sample-applications-202412",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202412/sample_applications/single_query",
    scopes: [
      {
        name: "creator.affiliate_collaboration.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-creator-sample-application-detail-202412",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202409/sample_applications/fulfillments/search",
    scopes: [
      {
        name: "creator.affiliate_collaboration.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/creator-search-sample-application-fulfillments-202409",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202505/affiliate_sharing_links/general_publishers/generate_batch",
    scopes: [
      {
        name: "creator.affiliate.share_link.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/generate-general-sharing-links-202505",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202504/affiliate_sharing_links/publisher/{publisher_id}/generate_batch",
    scopes: [
      {
        name: "creator.affiliate.share_link.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/generate-publisher-sharing-links-in-batch-202504",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202505/orders/trace/search",
    scopes: [
      {
        name: "creator.affiliate.share_link.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-affiliate-orders-by-creator-202505",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202410/orders/search",
    scopes: [
      {
        name: "creator.affiliate_collaboration.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-creator-affiliate-orders-202410",
  },
  {
    method: "GET",
    path: "/affiliate_creator/202412/samples/labels",
    scopes: [
      {
        name: "creator.affiliate_collaboration.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/check-creator-sample-eligibility-202412",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202505/videos/video_files",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-shoppable-video-file-202505",
  },
  {
    method: "GET",
    path: "/affiliate_creator/202509/shop_products",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shop-products-202509",
  },
  {
    method: "GET",
    path: "/affiliate_creator/202509/videos/{video_id}/status",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shoppable-video-status-202509",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202511/videos/precheck_task",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-video-precheck-task-202511",
  },
  {
    method: "GET",
    path: "/affiliate_creator/202601/videos/precheck_tasks/{task_id}",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shoppable-video-precheck-result-202601",
  },
  {
    method: "GET",
    path: "/affiliate_creator/202511/videos/precheck_tasks/{task_id}",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-shoppable-video-precheck-result-202511",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202511/photos/photo_files",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-shoppable-photo-file-202511",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202603/videos",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/post-shoppable-video-202603",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202505/videos",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/post-shoppable-video-202505",
  },
  {
    method: "GET",
    path: "/affiliate_creator/202606/toko_product_mappers",
    scopes: [
      {
        name: "creator.affiliate_collaboration.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/map-tokopedia-to-tiktok-shop-product-ids-202606",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202607/map_toko_product",
    scopes: [
      {
        name: "creator.affiliate.share_link.read",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-tokopedia-and-tiktok-shop-product-id-mappings-202607",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202610/photos",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/post-shoppable-photos-202610",
  },
  {
    method: "POST",
    path: "/affiliate_creator/202607/photos",
    scopes: [
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/post-shoppable-photos-202607",
  },
  {
    method: "POST",
    path: "/affiliate_partner/202405/campaigns",
    scopes: [
      {
        name: "partner.tap_campaign.write",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-affiliate-partner-campaign-202405",
  },
  {
    method: "POST",
    path: "/affiliate_partner/202405/campaigns/{campaign_id}/partial_edit",
    scopes: [
      {
        name: "partner.tap_campaign.write",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/edit-affiliate-partner-campaign-202405",
  },
  {
    method: "POST",
    path: "/affiliate_partner/202405/campaigns/{campaign_id}/publish",
    scopes: [
      {
        name: "partner.tap_campaign.write",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/publish-affiliate-partner-campaign-202405",
  },
  {
    method: "POST",
    path: "/affiliate_partner/202405/campaigns/{campaign_id}/products/{product_id}/review",
    scopes: [
      {
        name: "partner.tap_campaign.product.write",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/review-affiliate-partner-campaign-product-202405",
  },
  {
    method: "POST",
    path: "/affiliate_partner/202405/campaigns/{campaign_id}/products/{product_id}/promotion_link/generate",
    scopes: [
      {
        name: "partner.tap_campaign.link.write",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/generate-affiliate-partner-campaign-product-link-202405",
  },
  {
    method: "GET",
    path: "/affiliate_partner/202405/campaigns/{campaign_id}",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-affiliate-partner-campaign-detail-202405",
  },
  {
    method: "GET",
    path: "/affiliate_partner/202405/campaigns",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-affiliate-partner-campaign-list-202405",
  },
  {
    method: "GET",
    path: "/affiliate_partner/202405/campaigns/{campaign_id}/products",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-affiliate-partner-campaign-product-list-202405",
  },
  {
    method: "GET",
    path: "/affiliate_partner/202501/campaigns/{campaign_id}/products/performance",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-campaign-product-performance-list-202501",
  },
  {
    method: "POST",
    path: "/affiliate_partner/202505/campaigns/{campaign_id}/products/promotion_links/generate_batch",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/generate-campaign-product-promotion-links-in-batch-202505",
  },
  {
    method: "GET",
    path: "/affiliate_partner/202508/campaigns/{campaign_id}/products/{product_id}/performance",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-creator-performance-for-campaign-product-202508",
  },
  {
    method: "GET",
    path: "/affiliate_partner/202501/campaigns/{campaign_id}/products/{product_id}/performance",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-creator-performance-for-campaign-product-202501",
  },
  {
    method: "GET",
    path: "/affiliate_partner/202508/campaigns/{campaign_id}/products/{product_id}/creator/{creator_temp_id}/content/statistics",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl:
      "https://partner.tiktokshop.com/docv2/page/get-affiliate-campaign-creator-product-content-statistics-202508",
  },
  {
    method: "GET",
    path: "/affiliate_partner/202501/campaigns/{campaign_id}/products/{product_id}/creator/{creator_temp_id}/content/statistics",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl:
      "https://partner.tiktokshop.com/docv2/page/get-affiliate-campaign-creator-product-content-statistics-202501",
  },
  {
    method: "GET",
    path: "/affiliate_partner/202508/campaigns/{campaign_id}/products/{product_id}/creator/{creator_temp_id}/content/statistics/sample/status",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl:
      "https://partner.tiktokshop.com/docv2/page/get-affiliate-campaign-creator-product-sample-status-202508",
  },
  {
    method: "GET",
    path: "/affiliate_partner/202501/campaigns/{campaign_id}/products/{product_id}/creator/{creator_temp_id}/content/statistics/sample/status",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl:
      "https://partner.tiktokshop.com/docv2/page/get-affiliate-campaign-creator-product-sample-status-202501",
  },
  {
    method: "POST",
    path: "/affiliate_partner/202603/cap_order/search",
    scopes: [
      {
        name: "partner.cap_orders.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-cap-affiliate-orders-202603",
  },
  {
    method: "POST",
    path: "/affiliate_partner/202504/cap_order/search",
    scopes: [
      {
        name: "partner.cap_orders.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-cap-affiliate-orders-202504",
  },
  {
    method: "POST",
    path: "/affiliate_partner/202603/orders/search",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-tap-affiliate-orders-202603",
  },
  {
    method: "POST",
    path: "/affiliate_partner/202411/orders/search",
    scopes: [
      {
        name: "partner.tap_campaign.read",
        authType: 4,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-tap-affiliate-orders-202411",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202409/open_collaboration_settings",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-open-collaboration-settings-202409",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202405/open_collaboration_settings",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/edit-open-collaboration-settings-202405",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202410/open_collaborations/sample_rules",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-open-collaboration-sample-rules-202410",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202410/open_collaborations/sample_rules",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/edit-open-collaboration-sample-rule-202410",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202412/open_collaborations",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-open-collaboration-202412",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202405/open_collaborations",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-open-collaboration-202405",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202412/open_collaborations/search",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-open-collaborations-202412",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202409/open_collaborations/search",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-open-collaborations-202409",
  },
  {
    method: "DELETE",
    path: "/affiliate_seller/202409/open_collaborations/products/{product_id}",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/remove-open-collaboration-202409",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202508/open_collaborations/creator_content_details",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-open-collaboration-creator-content-details-202508",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202412/open_collaborations/creator_content_details",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-open-collaboration-creator-content-details-202412",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202405/open_collaborations/products/search",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/seller-search-open-collaboration-products-202405",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202508/open_collaborations/{open_collaboration_id}/remove_creator",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/remove-creator-from-open-collaboration-product-202508",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202405/open_collaborations/{open_collaboration_id}/remove_creator",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/remove-creator-from-open-collaboration-product-202405",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202508/target_collaborations",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-target-collaboration-202508",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202405/target_collaborations",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-target-collaboration-202405",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202508/target_collaborations/search",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-target-collaborations-202508",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202409/target_collaborations/search",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-target-collaborations-202409",
  },
  {
    method: "PUT",
    path: "/affiliate_seller/202508/target_collaborations/{target_collaboration_id}",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-target-collaboration-202508",
  },
  {
    method: "PUT",
    path: "/affiliate_seller/202409/target_collaborations/{target_collaboration_id}",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-target-collaboration-202409",
  },
  {
    method: "DELETE",
    path: "/affiliate_seller/202409/target_collaborations/{target_collaboration_id}",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/remove-target-collaboration-202409",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202508/target_collaborations/{target_collaboration_id}",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/query-target-collaboration-detail-202508",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202412/target_collaborations/{target_collaboration_id}",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/query-target-collaboration-detail-202412",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202409/target_collaborations/{target_collaboration_id}",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/query-target-collaboration-detail-202409",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202412/conversations",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-conversation-list-202412",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202412/conversation/{conversation_id}/messages",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-creator-conversation-messages-202412",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202412/conversations/messages/list/newest",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-latest-unread-messages-202412",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202508/conversations",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-or-create-creator-conversation-202508",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202412/conversations",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-or-create-creator-conversation-202412",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202511/images/upload",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-message-image-202511",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202412/conversations/{conversation_id}/messages",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/send-im-message-202412",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202412/conversatons/read",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/mark-conversations-as-read-202412",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202508/sample_applications/search",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-sample-applications-202508",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202507/sample_applications/search",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-sample-applications-202507",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202409/sample_applications/search",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-sample-applications-202409",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202507/sample_applications/{application_id}/review",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/review-a-sample-application-202507",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202409/sample_applications/{application_id}/review",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/review-a-sample-application-202409",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202409/sample_applications/{application_id}/fulfillments/search",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-sample-application-fulfillments-202409",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202509/target_collaboration/{target_collaboration_id}/link",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/generate-target-collaboration-link-202509",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202405/products/{product_id}/promotion_link/generate",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/generate-affiliate-product-promotion-link-202405",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202512/sample_applications/deeplink",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/seller-get-sample-request-deeplink-202512",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202410/orders/search",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-seller-affiliate-orders-202410",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202603/compass/offline_task",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/create-compass-offline-export-task-202603",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202603/compass/offline_tasks",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-compass-task-list-202603",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202603/compass/offline_tasks/{task_id}/file",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/download-compass-task-file-202603",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202605/target_collaborations/conflicts/check",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/check-target-collaboration-conflicts-202605",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202605/target_collaborations/conflicts/resolve",
    scopes: [
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/resolve-target-collaboration-conflicts-202605",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202608/creator_outreach/records/query",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-weekly-creator-outreach-records-202608",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202608/conversations/group_counts",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-inbox-category-counts-202608",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202608/conversations/{conversation_id}/status",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/update-conversation-status-202608",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202608/target_collaborations/creator_promotion_details/query",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
      {
        name: "seller.affiliate_collaboration.write",
        authType: 1,
      },
    ],
    officialUrl:
      "https://partner.tiktokshop.com/docv2/page/query-creator-promotion-details-in-target-collaboration-202608",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202608/media/upload",
    scopes: [
      {
        name: "seller.affiliate_messages.write",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-message-image-v2-202608",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202607/creator_outreach/quota",
    scopes: [
      {
        name: "seller.affiliate_collaboration.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-weekly-creator-outreach-quota-202607",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202608/marketplace_creators/{creator_user_id}",
    scopes: [
      {
        name: "seller.creator_marketplace.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-marketplace-creator-performance-202608",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202508/marketplace_creators/{creator_user_id}",
    scopes: [
      {
        name: "seller.creator_marketplace.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-marketplace-creator-performance-202508",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202505/marketplace_creators/{creator_user_id}",
    scopes: [
      {
        name: "seller.creator_marketplace.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-marketplace-creator-performance-202505",
  },
  {
    method: "GET",
    path: "/affiliate_seller/202406/marketplace_creators/{creator_user_id}",
    scopes: [
      {
        name: "seller.creator_marketplace.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-marketplace-creator-performance-202406",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202608/marketplace_creators/search/filter",
    scopes: [
      {
        name: "seller.creator_marketplace.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-creator-marketplace-advanced-search-filters-202608",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202601/marketplace_creators/search/filter",
    scopes: [
      {
        name: "seller.creator_marketplace.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/get-creator-marketplace-advanced-search-filters-202601",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202608/marketplace_creators/search",
    scopes: [
      {
        name: "seller.creator_marketplace.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-creators-in-creator-marketplace-202608",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202508/marketplace_creators/search",
    scopes: [
      {
        name: "seller.creator_marketplace.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-creators-in-creator-marketplace-202508",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202505/marketplace_creators/search",
    scopes: [
      {
        name: "seller.creator_marketplace.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-creators-in-creator-marketplace-202505",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202406/marketplace_creators/search",
    scopes: [
      {
        name: "seller.creator_marketplace.read",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/search-creators-in-creator-marketplace-202406",
  },
  {
    method: "POST",
    path: "/affiliate_seller/202610/creator_outreach/eligibility/check",
    scopes: [],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/check-creator-outreach-eligibility-202610",
  },
  {
    method: "POST",
    path: "/supply_chain/202309/packages/sync",
    scopes: [
      {
        name: "seller.fulfillment.basic",
        authType: 1,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/confirm-package-shipment-202309",
  },
  {
    method: "POST",
    path: "/open/202512/file/init",
    scopes: [
      {
        name: "seller.customer_service",
        authType: 1,
      },
      {
        name: "creator.video.write",
        authType: 2,
      },
    ],
    officialUrl: "https://partner.tiktokshop.com/docv2/page/upload-file-init-202512",
  },
];
