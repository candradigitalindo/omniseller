# Reviewed Shopee commerce request schemas

The pinned source remains Shopee documentation mirror commit
`300344af94cf347268b50847baf14b9c28aaf1ae`. The navigation contains 428 API
endpoints. The commerce catalog has one additional application action for a
private OBS credentials file; that action calls the existing documented
`livestream.get_session_detail` endpoint and does not count as another API.

`tools/shopee-commerce-schema-reviews.json` records 37 request-table reviews. Each
review includes the unchanged source request rows, the structured-document
SHA-256, the canonical request-row SHA-256, every row's wire path, a rationale,
and any explicit omission or typed correction. The compiler rejects changed rows,
undocumented field names, duplicate wire paths, missing parents and unexplained
omissions. It never repairs malformed example JSON silently.

These reviews add nested operations for bundle/add-on/discount promotions, kit
products, product/model/variation edits, Indonesian prescription orders, booking
and batch logistics, operating hours, flash-sale campaign quotas, brand
registration and query/search reads. Repeated field names such as `min_amount`,
`image_id_list` and `tracking_number` retain their distinct documented parents.
Optional item-level and variation-level discount examples share a reviewed union;
they do not require identical example values or identical optional fields.

IDs stay decimal strings until the signed transport emits an exact JSON integer.
Five GET list contracts use their documented encodings: comma-separated product
IDs, a JSON array for direct/main item IDs, or repeated `item_status` parameters.
There is no global guessed array encoding. Numeric pagination cursors likewise
remain exact decimal text. Dates, local operating clocks, Unix timestamps and
Rupiah fields keep separate formats.

The documented millisecond timestamp on Video's `scheduled_post_time` overrides
the generic Shopee timestamp default. Write acknowledgements inspect both object
and top-level array responses. Nonempty or malformed documented failure lists,
failed Video identifiers and an unsuccessful prescription `is_success` cannot
become accepted results; the corresponding empty failure lists remain valid.

`commerce-constraints.ts` checks documented alternatives before HTTP: the selected
bundle price rule, item versus variation discount/flash-sale inputs, campaign
quota minima, document source alternatives and the 600-copy total, Indonesian
pharmacist/rejection requirements, rich-text/image description branches,
pre-order shipping days, and valid half-hour operating clocks/calendar dates.
Stock changes and ordinary product price pushes remain in their owning workflows.
Flash-sale stock is a campaign reservation quota and never writes inventory facts.

The seller media and creator video transports are composite workflows. Their
part-upload and completion endpoints remain delegated to those workflows rather
than exposed as unrelated forms. User-based Video/LIVE operations use a separate
creator connection; a seller token is never reused as a user token. Private stream
keys and document links are excluded from ordinary result projections.

Unresolved source conflicts remain explicit:

- `get_item_violation_info` and `get_ssp_info` have no verified GET array encoding.
- `get_direct_shop_recommended_price` has no verified nested-object GET encoding.
- `get_booking_list` places the next cursor inconsistently in an error example.
- FBS tax invoice documents do not establish Indonesia eligibility, and their
  status/envelope and private download host contracts are inconsistent or missing.
- `get_mart_item_by_outlet_item_id` explicitly grants access to no application type.
- The optional primary-image subtree in `update_item` contradicts the source table
  (`object[]`) and example (empty objects); it is excluded, as are tax,
  certification and complaint subtrees explicitly specific to other countries.
- Product stock mutations and SIP price changes require their owning workflows.

Run the offline review tests with:

```sh
python3 -m unittest discover -s tools -p 'test_generate_shopee_commerce_contracts.py' -v
pnpm --filter @omniseller/connector-shopee typecheck
pnpm --filter @omniseller/connector-shopee test
```

Regenerate from the downloaded pinned snapshot (data only):

```sh
python3 tools/generate-shopee-commerce.py --snapshot /path/to/shopee
pnpm exec biome check --write packages/connectors/shopee/src/commerce-contracts.ts docs/audits/shopee-commerce-method-evidence.json
```

The output embeds source, compiler and review checksums. Regenerating with the
same pinned input and review files produces the same formatted catalog and method
evidence; a count of catalog entries is not a claim of production permission.
