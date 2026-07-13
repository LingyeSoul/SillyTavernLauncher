import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from ruamel.yaml import YAML


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from features.st.config import (  # noqa: E402
    DEFAULT_PRIVATE_ADDRESS_RANGES,
    stcfg,
)
from ui.dialogs.ip_whitelist_dialog import IpWhitelistDialog  # noqa: E402


class SillyTavernConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.base_dir = Path(self.temp_dir.name) / "SillyTavern"
        self.base_dir.mkdir()
        self.config_path = self.base_dir / "config.yaml"
        self.getcwd_patch = patch(
            "features.st.config.os.getcwd", return_value=self.temp_dir.name
        )
        self.getcwd_patch.start()
        self.addCleanup(self.getcwd_patch.stop)

    def _write_config(self, content: str) -> None:
        self.config_path.write_text(content, encoding="utf-8")

    def _read_config(self):
        yaml = YAML()
        with self.config_path.open("r", encoding="utf-8") as file:
            return yaml.load(file)

    def test_private_address_whitelist_round_trip_preserves_unknown_fields(self):
        self._write_config(
            """
listen: false
privateAddressWhitelist:
  enabled: true
  allowUnresolvedHosts: true
  customOption: keep-me
  log:
    blockedRequests: false
    allowedRequests: true
  allowedRanges:
    - 192.168.50.*
""".lstrip()
        )

        config = stcfg()

        self.assertTrue(config.private_address_whitelist_enabled)
        self.assertTrue(config.private_address_allow_unresolved_hosts)
        self.assertFalse(config.private_address_log_blocked)
        self.assertTrue(config.private_address_log_allowed)
        self.assertEqual(config.private_address_allowed_ranges, ["192.168.50.*"])

        config.private_address_allowed_ranges.append("10.0.0.0/8")
        config.save_config()
        saved = self._read_config()["privateAddressWhitelist"]

        self.assertEqual(saved["customOption"], "keep-me")
        self.assertEqual(saved["allowedRanges"], ["192.168.50.*", "10.0.0.0/8"])
        self.assertTrue(saved["enabled"])
        self.assertTrue(saved["allowUnresolvedHosts"])
        self.assertFalse(saved["log"]["blockedRequests"])
        self.assertTrue(saved["log"]["allowedRequests"])

    def test_create_whitelist_enables_filter_with_least_privilege_defaults(self):
        self._write_config("listen: false\n")
        config = stcfg()
        network_manager = Mock()
        network_manager.get_local_ip.return_value = "192.168.42.17"

        with patch(
            "features.st.config.get_network_manager",
            return_value=network_manager,
        ):
            result = config.create_whitelist()

        self.assertTrue(result)
        self.assertTrue(config.private_address_whitelist_enabled)
        self.assertIn("192.168.42.*", config.whitelist_ips)
        self.assertNotIn("192.168.42.*", config.private_address_allowed_ranges)
        for address_range in DEFAULT_PRIVATE_ADDRESS_RANGES:
            self.assertIn(address_range, config.private_address_allowed_ranges)

        saved = self._read_config()["privateAddressWhitelist"]
        self.assertTrue(saved["enabled"])
        self.assertNotIn("192.168.42.*", saved["allowedRanges"])

    def test_invalid_private_address_whitelist_uses_safe_defaults(self):
        self._write_config("privateAddressWhitelist: invalid\n")

        config = stcfg()
        config.save_config()
        saved = self._read_config()["privateAddressWhitelist"]

        self.assertFalse(saved["enabled"])
        self.assertEqual(
            list(saved["allowedRanges"]), list(DEFAULT_PRIVATE_ADDRESS_RANGES)
        )
        self.assertTrue(saved["log"]["blockedRequests"])
        self.assertFalse(saved["log"]["allowedRequests"])


class IpWhitelistDialogTests(unittest.TestCase):
    def test_parse_lines_strips_blanks_and_removes_duplicates(self):
        result = IpWhitelistDialog._parse_lines(
            "192.168.1.*\n\n  127.0.0.0/8  \n192.168.1.*\n"
        )

        self.assertEqual(result, ["192.168.1.*", "127.0.0.0/8"])


if __name__ == "__main__":
    unittest.main()
