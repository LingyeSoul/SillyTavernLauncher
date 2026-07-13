import sys
import tempfile
import unittest
from pathlib import Path


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from features.sync.client import SyncClient  # noqa: E402
from features.sync.server import SyncServer  # noqa: E402


class SyncSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.server = SyncServer(
            data_path=self.temp_dir.name,
            host="127.0.0.1",
            auth_token="test-token",
        )
        self.client = self.server.app.test_client()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_health_is_public_without_leaking_data_path(self):
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["auth_required"])
        self.assertNotIn("data_path", response.get_json())

    def test_data_endpoint_rejects_missing_token(self):
        response = self.client.get("/info")

        self.assertEqual(response.status_code, 401)

    def test_data_endpoint_accepts_bearer_token(self):
        response = self.client.get(
            "/info",
            headers={"Authorization": "Bearer test-token"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("data_path", response.get_json()["server_info"])

    def test_client_extracts_token_fragment_without_sending_it_in_url(self):
        client = SyncClient(
            "http://192.168.1.2:9999#token=test-token",
            self.temp_dir.name,
        )
        self.addCleanup(client.close)

        self.assertEqual(client.server_url, "http://192.168.1.2:9999")
        self.assertEqual(client.session.headers["Authorization"], "Bearer test-token")


if __name__ == "__main__":
    unittest.main()
