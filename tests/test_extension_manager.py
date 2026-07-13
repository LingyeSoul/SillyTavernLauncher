import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from features.extensions.extension_manager import (  # noqa: E402
    ExtensionManager,
    ExtensionType,
)


class ExtensionManagerSecurityTests(unittest.TestCase):
    def setUp(self):
        self.manager = ExtensionManager.__new__(ExtensionManager)
        self.manager.config_manager = SimpleNamespace(get=lambda *_: "github")
        self.manager.log_callback = None
        self.manager._lock = None

    def test_extension_name_rejects_path_and_shell_metacharacters(self):
        for name in ("../outside", "nested/name", "name & whoami", 'name"bad'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.manager._validate_extension_name(name)

    def test_safe_extension_path_stays_under_managed_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            result = self.manager._safe_extension_path(temp_dir, "safe-name_1")

            self.assertEqual(result, os.path.join(os.path.realpath(temp_dir), "safe-name_1"))

    def test_git_install_rejects_unsafe_custom_name_before_execution(self):
        self.manager._get_global_ext_path = Mock(return_value=os.getcwd())
        self.manager._ensure_dir_exists = Mock()

        with patch("features.extensions.extension_manager.subprocess.run") as run:
            success, _ = self.manager.install_from_git(
                "https://github.com/example/repository.git",
                ExtensionType.GLOBAL,
                "../outside",
            )

        self.assertFalse(success)
        run.assert_not_called()

    def test_git_install_uses_argument_list_without_shell(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            self.manager._get_global_ext_path = Mock(return_value=temp_dir)
            self.manager._ensure_dir_exists = Mock()
            self.manager._is_valid_extension = Mock(return_value=True)
            completed = SimpleNamespace(returncode=0, stderr="")

            with (
                patch(
                    "features.extensions.extension_manager._get_git_command",
                    return_value=("git", False),
                ),
                patch(
                    "features.extensions.extension_manager.subprocess.run",
                    return_value=completed,
                ) as run,
            ):
                success, _ = self.manager.install_from_git(
                    "https://github.com/example/repository.git",
                    ExtensionType.GLOBAL,
                    "safe-name",
                )

            self.assertTrue(success)
            args, kwargs = run.call_args
            self.assertEqual(args[0][:4], ["git", "clone", "--", "https://github.com/example/repository.git"])
            self.assertFalse(kwargs["shell"])


if __name__ == "__main__":
    unittest.main()
