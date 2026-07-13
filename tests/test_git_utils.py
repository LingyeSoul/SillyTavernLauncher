import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from core.git_utils import _format_git_cmd, run_git_command  # noqa: E402


class GitCommandSecurityTests(unittest.TestCase):
    def test_format_git_command_preserves_quoted_argument(self):
        command = _format_git_cmd(
            "C:/Program Files/Git/bin/git.exe",
            True,
            'stash push -m "版本切换前保存 abc1234"',
        )

        self.assertEqual(command[0], "C:/Program Files/Git/bin/git.exe")
        self.assertEqual(command[-1], "版本切换前保存 abc1234")

    def test_run_git_command_never_uses_shell(self):
        with (
            patch("core.git_utils._get_git_command", return_value=("git", False)),
            patch("core.git_utils.subprocess.run") as run,
        ):
            run_git_command(["status", "--porcelain"], "working-directory")

        run.assert_called_once_with(
            ["git", "status", "--porcelain"],
            cwd="working-directory",
            shell=False,
        )


if __name__ == "__main__":
    unittest.main()
