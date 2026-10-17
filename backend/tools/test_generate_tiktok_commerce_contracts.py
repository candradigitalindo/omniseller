"""Security and contract regressions for the offline documentation compiler."""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

GENERATOR = pathlib.Path(__file__).with_name("generate-tiktok-commerce-contracts.py")


class CommerceContractCompilerTest(unittest.TestCase):
    def fixture(self, root, *, title="Create Affiliate Partner Campaign", group="Affiliate partner", method="POST", path="/affiliate_partner/202405/campaigns", body=None):
        root = pathlib.Path(root)
        for directory in ("details", "api-meta", "versions"):
            (root / directory).mkdir()
        tree = {"data": {"document_tree": [
            {"document_id": "api", "parent_id": "", "name": "API Reference", "is_dir": True},
            {"document_id": "group", "parent_id": "api", "name": group, "is_dir": True},
            {"document_id": "test-document", "parent_id": "group", "name": title, "is_dir": False, "is_api_doc": True, "doc_type": 1},
        ]}}
        (root / "tree.json").write_text(json.dumps(tree))
        (root / "versions/test-document.json").write_text(json.dumps({"api_external_list": [{"external_doc_id": "test-document", "version": 202405}]}))
        capture = {"issues": [], "fetched_at": "2026-10-17T00:00:00Z", "tree_sha256": hashlib.sha256((root / "tree.json").read_bytes()).hexdigest()}
        (root / "snapshot.json").write_text(json.dumps(capture))
        (root / "details/test-document.json").write_text(json.dumps({"content": f"# Path: {path}\n# Method: [{method}]\n# Function Description\nA documented operation.\n---\n"}))
        metadata = {"document_api_meta": {
            "interface_path": path,
            "request_header_param": [{"name": "x-tts-access-token", "desc": "The partner access token when user_type = 3."}],
            "request_query_param": [
                {"name": "app_key", "type": "string", "required": "Y", "desc": "App key."},
                {"name": "category_asset_cipher", "type": "string", "required": "Y", "desc": "Private authorized category asset."},
            ],
            "request_body_param": body or [],
            "scope_list": [{"scope_key": "partner.tap_campaign.write", "auth_type": 4}],
            "response_param": [
                {"name": "code", "type": "int", "required": "N"},
                {"name": "data", "type": "object", "required": "N"},
                {"name": "^campaign_id", "type": "string", "required": "N"},
                {"name": "^access_token", "type": "string", "required": "N"},
            ],
        }}
        (root / "api-meta/test-document.json").write_text(json.dumps(metadata))
        return root

    def generate(self, root):
        return subprocess.run([sys.executable, str(GENERATOR), "--snapshot", str(root), "--output-dir", str(root / "generated"), "--data-output-dir", str(root / "data")], text=True, capture_output=True)

    def operation(self, root):
        return json.loads((root / "data/tiktokshop.catalog.json").read_text())[0]

    def test_rejects_modified_navigation_before_writing_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            (root / "tree.json").write_text((root / "tree.json").read_text() + " ")
            result = self.generate(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Navigation checksum mismatch", result.stderr)
            self.assertFalse((root / "generated").exists())

    def test_rejects_incomplete_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            (root / "api-meta/test-document.json").unlink()
            result = self.generate(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Missing metadata", result.stderr)
            self.assertFalse((root / "generated").exists())

    def test_preserves_nested_inputs_and_applies_documented_indonesia_condition(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory, body=[
                {"name": "contact_info", "type": "object", "required": "Y", "desc": "Campaign contact."},
                {"name": "^whatsapp", "type": "string", "required": "N", "desc": "Required if the target market is MY, SG, GB, or ID; otherwise optional."},
                {"name": "campaign_start_time", "type": "int", "required": "Y", "desc": "Unix timestamp in seconds."},
                {"name": "commission_rate", "type": "int", "required": "Y", "desc": "The commission rate in hundredths of a percent."},
            ])
            self.assertEqual(self.generate(root).returncode, 0)
            operation = self.operation(root)
            self.assertTrue(operation["available"])
            self.assertEqual(operation["principalKind"], "affiliate_partner")
            self.assertTrue(operation["categoryAsset"])
            self.assertEqual([field["name"] for field in operation["fields"]], ["body.contact_info", "body.campaign_start_time", "body.commission_rate"])
            self.assertTrue(operation["fields"][0]["children"][0]["required"])
            self.assertEqual(operation["fields"][1]["format"], "datetime")
            self.assertNotIn("format", operation["fields"][2])
            self.assertEqual(operation["responseFields"], ["campaign_id"])
            self.assertEqual(operation["eligibility"], "unverified")

    def test_disables_undocumented_path_parameters_and_get_bodies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory, method="GET", path="/affiliate_partner/202405/campaigns/{campaign_id}", body=[{"name": "filter", "type": "string", "required": "N"}])
            self.assertEqual(self.generate(root).returncode, 0)
            operation = self.operation(root)
            self.assertFalse(operation["available"])
            self.assertIn("GET body", operation["unavailableReason"])
            self.assertIn("Path parameter schema missing:campaign_id", operation["unavailableReason"])

    def test_preserves_every_enum_bullet_including_adjacent_message_types(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory, body=[{
                "name": "type", "type": "string", "required": "Y",
                "desc": "Message type. Possible enumerations:\n- `TEXT`\n- `IMAGE`\n- `VIDEO`\n- `PRODUCT_CARD`\n- `ORDER_CARD`\n- `RETURN_REFUND_CARD`\n- `COUPON_CARD`\n- `LOGISTICS_CARD`",
            }])
            self.assertEqual(self.generate(root).returncode, 0)
            self.assertEqual(self.operation(root)["fields"][0]["options"], [
                "TEXT", "IMAGE", "VIDEO", "PRODUCT_CARD", "ORDER_CARD", "RETURN_REFUND_CARD", "COUPON_CARD", "LOGISTICS_CARD",
            ])

    def test_does_not_assign_a_neighboring_api_scope_when_undocumented(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            file = root / "api-meta/test-document.json"
            metadata = json.loads(file.read_text())
            metadata["document_api_meta"].pop("scope_list")
            file.write_text(json.dumps(metadata))
            self.assertEqual(self.generate(root).returncode, 0)
            operation = self.operation(root)
            self.assertFalse(operation["available"])
            self.assertEqual(operation["scopes"], [])
            self.assertIn("scope has not been documented", operation["unavailableReason"])

    def test_reviewed_exceptions_require_the_exact_source_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            reviewed_id = "6a335dc2f180ee049bf09ed6"
            for directory in ["api-meta", "details", "versions"]:
                file = root / directory / "test-document.json"
                file.rename(file.with_name(reviewed_id + ".json"))
            tree_file = root / "tree.json"
            tree_file.write_text(tree_file.read_text().replace("test-document", reviewed_id))
            snapshot_file = root / "snapshot.json"
            snapshot = json.loads(snapshot_file.read_text())
            snapshot["tree_sha256"] = hashlib.sha256(tree_file.read_bytes()).hexdigest()
            snapshot_file.write_text(json.dumps(snapshot))
            result = self.generate(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Reviewed contract source changed", result.stderr)
            self.assertFalse((root / "generated").exists())

    def test_generates_only_query_array_encodings_proven_by_official_examples(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            file = root / "api-meta/test-document.json"
            metadata = json.loads(file.read_text())
            meta = metadata["document_api_meta"]
            meta["request_query_param"].append({"name": "ids", "type": "[]string", "required": "Y", "desc": "Identifiers."})
            meta["query"] = "https://open-api.tiktokglobalshop.com/affiliate_partner/202405/campaigns?ids=123,456"
            file.write_text(json.dumps(metadata))
            self.assertEqual(self.generate(root).returncode, 0)
            self.assertIn('"ids": "csv"', (root / "generated/commerce-query-contracts.ts").read_text())
            meta["query"] = "https://open-api.tiktokglobalshop.com/affiliate_partner/202405/campaigns"
            file.write_text(json.dumps(metadata))
            result = self.generate(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("encoding is not proven", result.stderr)

    def test_blocks_event_mutations_and_keeps_post_search_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory, title="Delete Webhook for an Event", group="Event", method="DELETE", path="/event/202309/webhooks")
            self.assertEqual(self.generate(root).returncode, 0)
            self.assertIn("dedicated connection workflow", self.operation(root)["unavailableReason"])
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory, title="Search Affiliate Partner Campaigns")
            self.assertEqual(self.generate(root).returncode, 0)
            self.assertFalse(self.operation(root)["write"])


    def test_infers_creator_analytics_from_scope_metadata_not_sidebar_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory, title="Get Live Room Core Stats", group="Analytics", method="GET", path="/analytics/202502/live_rooms/core_stats")
            file = root / "api-meta/test-document.json"
            metadata = json.loads(file.read_text())
            metadata["document_api_meta"]["scope_list"] = [{"scope_key": "creator.data.live.read.public", "auth_type": 2}]
            metadata["document_api_meta"]["request_header_param"] = [{"name": "x-tts-access-token", "desc": "Creator access_token, user_type = 1."}]
            file.write_text(json.dumps(metadata))
            self.assertEqual(self.generate(root).returncode, 0)
            operation = self.operation(root)
            self.assertEqual(operation["principalKind"], "creator")
            self.assertEqual(operation["scopes"], ["creator.data.live.read.public"])
            self.assertEqual(operation["scopeMode"], "any")

    def test_blocks_global_operations_even_with_seller_token_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory, title="Get Global Categories", group="Products", method="GET", path="/product/202309/global_categories")
            file = root / "api-meta/test-document.json"
            metadata = json.loads(file.read_text())
            metadata["document_api_meta"]["scope_list"] = [{"scope_key": "seller.global_product.category.info", "auth_type": 1}]
            metadata["document_api_meta"]["request_header_param"] = [{"name": "x-tts-access-token", "desc": "Seller access_token, user_type = 0."}]
            file.write_text(json.dumps(metadata))
            self.assertEqual(self.generate(root).returncode, 0)
            self.assertFalse(self.operation(root)["available"])
            self.assertIn("outside the Indonesia", self.operation(root)["unavailableReason"])



    def test_keeps_documented_timestamp_unit_and_scope_preflight_semantics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory, body=[{"name": "event_time", "type": "int", "required": "Y", "desc": "Unix timestamp in milliseconds."}])
            file = root / "api-meta/test-document.json"
            metadata = json.loads(file.read_text())
            metadata["document_api_meta"]["scope_list"].append({"scope_key": "partner.another.documented_package", "auth_type": 4})
            file.write_text(json.dumps(metadata))
            self.assertEqual(self.generate(root).returncode, 0)
            operation = self.operation(root)
            self.assertEqual(operation["fields"][0]["format"], "datetime")
            self.assertEqual(operation["fields"][0]["timestampUnit"], "milliseconds")
            self.assertEqual(operation["scopeMode"], "any")
            self.assertEqual(operation["scopes"], ["partner.tap_campaign.write", "partner.another.documented_package"])
            self.assertIn("not proof", operation["eligibilityReason"])


if __name__ == "__main__":
    unittest.main()
