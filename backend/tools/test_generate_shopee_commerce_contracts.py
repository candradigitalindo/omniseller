"""Offline regression tests for hash-pinned Shopee nested schema reviews."""
from copy import deepcopy
import json
from pathlib import Path
import unittest
from shopee_commerce_schema import compile_field, request_digest, reviewed_schema

REVIEWS = json.loads(Path(__file__).with_name("shopee-commerce-schema-reviews.json").read_text())["reviews"]


def flatten(fields, prefix=""):
    result = {}
    for field in fields:
        path = prefix + field["name"]
        result[path] = field
        if "children" in field:
            result.update(flatten(field["children"], path + ("[]." if field["type"] == "array" else ".")))
    return result


class ShopeeSchemaReviewTest(unittest.TestCase):
    def compile(self, name, method="POST"):
        review = REVIEWS["v2." + name]
        return reviewed_schema(review["requestRows"], review, compile_field, method)

    def test_every_review_covers_all_pinned_rows_and_keeps_wire_ids_exact(self):
        for name, review in REVIEWS.items():
            with self.subTest(name=name):
                self.assertEqual(request_digest(review["requestRows"]), review["requestRowsSha256"])
                fields, numeric = reviewed_schema(review["requestRows"], review, compile_field, "POST")
                keys = flatten(fields)
                for path in numeric:
                    field = keys[path.removesuffix("[]")]
                    self.assertEqual(field.get("itemType") if field["type"] == "array" else field["type"], "string")

    def test_rejects_changed_docs_and_unreviewed_omissions(self):
        review = deepcopy(REVIEWS["v2.product.update_model"])
        rows = deepcopy(review["requestRows"])
        rows[0][4] += " Changed official contract."
        with self.assertRaisesRegex(ValueError, "changed"):
            reviewed_schema(rows, review, compile_field, "POST")
        review["rowPaths"][0] = None
        with self.assertRaisesRegex(ValueError, "Omitted"):
            reviewed_schema(review["requestRows"], review, compile_field, "POST")

    def test_rejects_path_aliases_unknown_containers_and_duplicate_wire_keys(self):
        original = REVIEWS["v2.product.update_model"]
        for path, message in [("different_id", "retain"), ("invented.item_id", "parent"), ("model[].item_id", "parent")]:
            review = deepcopy(original)
            review["rowPaths"][0] = path
            with self.assertRaisesRegex(ValueError, message):
                reviewed_schema(review["requestRows"], review, compile_field, "POST")

    def test_same_named_rows_cannot_be_flattened_to_a_duplicate_wire_key(self):
        review = deepcopy(REVIEWS["v2.bundle_deal.add_bundle_deal"])
        review["rowPaths"][10] = "min_amount"
        with self.assertRaisesRegex(ValueError, "Duplicate reviewed wire path"):
            reviewed_schema(review["requestRows"], review, compile_field, "POST")

    def test_duplicate_bundle_fields_are_scoped_to_their_parent_and_conditionally_required(self):
        fields, _ = self.compile("bundle_deal.add_bundle_deal")
        keys = flatten(fields)
        self.assertTrue(keys["body.min_amount"]["required"])
        self.assertTrue(keys["body.additional_tiers[].min_amount"]["required"])
        self.assertFalse(keys["body.fix_price"]["required"])
        self.assertEqual(keys["body.additional_tiers"]["maximum"], 2)
        self.assertEqual(keys["body.start_time"]["timestampUnit"], "seconds")
        self.assertEqual(keys["body.discount_value"]["format"], "money")

    def test_discount_union_keeps_item_and_model_price_paths_distinct(self):
        fields, numeric = self.compile("discount.update_discount_item")
        keys = flatten(fields)
        self.assertFalse(keys["body.item_list[].model_list"]["required"])
        self.assertTrue(keys["body.item_list[].model_list[].model_promotion_price"]["required"])
        self.assertIn("body.item_list[].model_list[].model_id", numeric)
        self.assertIn("body.item_list[].item_promotion_price", keys)

    def test_full_operating_hours_retains_each_days_fields_and_local_clock_format(self):
        fields, _ = self.compile("logistics.update_operating_hours")
        keys = flatten(fields)
        self.assertEqual(keys["body.instant_operating_hour.thrusday.start_time"]["format"], "time")
        self.assertEqual(keys["body.special_operating_hour.operating_hours[].date"]["format"], "date")
        self.assertEqual(keys["body.shop_collection_operating_hour.monday.end_time"]["format"], "time")

    def test_product_edit_excludes_foreign_and_inconsistent_fields_but_keeps_id_medicine(self):
        fields, numeric = self.compile("product.update_item")
        keys = flatten(fields)
        self.assertNotIn("body.tax_info", keys)
        self.assertNotIn("body.certification_info", keys)
        self.assertNotIn("body.image", keys)
        self.assertIn("body.medicine_id", numeric)
        self.assertIn("body.compatibility_info.vehicle_info_list[].model_id", numeric)
        self.assertIn("body.description_info.extended_description.field_list[].image_info.image_id", keys)
        self.assertEqual(keys["body.size_chart_info.size_chart"]["allowEmpty"], True)

    def test_no_undocumented_alias_or_unit_split_field_is_enabled(self):
        fields, _ = self.compile("logistics.set_address_config")
        self.assertEqual([field["name"] for field in fields], ["body.address_type_config"])
        fields, _ = self.compile("order.split_order")
        self.assertFalse(any(path.endswith("model_quantity") for path in flatten(fields)))

    def test_query_array_encodings_and_numeric_cursor_reviews_are_operation_specific(self):
        self.assertEqual(REVIEWS["v2.product.get_item_extra_info"]["queryArrays"], {"item_id_list": "comma"})
        self.assertEqual(REVIEWS["v2.product.get_direct_item_list"]["queryArrays"], {"main_item_id": "json"})
        self.assertEqual(REVIEWS["v2.product.search_item"]["queryArrays"], {"item_status": "repeat"})
        fields, numeric = self.compile("shop.get_shop_notification", "GET")
        self.assertEqual(fields[0]["type"], "string")
        self.assertIn("query.cursor", numeric)
        self.assertEqual(REVIEWS["v2.shop.get_shop_notification"]["pagination"], {"cursorPath": ["cursor"], "numeric": True})

    def test_documented_millisecond_timestamp_takes_precedence_over_generic_timestamp_default(self):
        field = compile_field(["scheduled_post_time", "timestamp", "False", "", "Scheduled post time, millisecond timestamp."])
        self.assertEqual(field["format"], "datetime")
        self.assertEqual(field["timestampUnit"], "milliseconds")
        seconds = compile_field(["start_time", "timestamp", "True", "1600000000", "Campaign start time."])
        self.assertEqual(seconds["timestampUnit"], "seconds")

    def test_nested_object_example_is_not_needed_to_invent_a_container(self):
        fields, numeric = self.compile("product.generate_kit_image")
        keys = flatten(fields)
        self.assertEqual(set(keys), {"body.component_list", "body.component_list[].component_item_id", "body.component_list[].component_model_id"})
        self.assertEqual(len(numeric), 2)


if __name__ == "__main__":
    unittest.main()
