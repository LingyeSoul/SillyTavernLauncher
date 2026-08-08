import asyncio
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from core.terminal import AsyncTerminal  # noqa: E402
from utils.logger import app_logger  # noqa: E402


class AsyncTerminalStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_extensionless_windows_script_prefers_cmd_companion(self):
        terminal = AsyncTerminal.__new__(AsyncTerminal)
        terminal._debug_mode = True
        terminal.add_log = Mock()
        terminal.create_process = Mock()
        process = SimpleNamespace(pid=123, returncode=None)

        with tempfile.TemporaryDirectory() as temp_dir:
            tool_dir = Path(temp_dir) / "tool dir"
            tool_dir.mkdir()
            launcher = tool_dir / "npm"
            launcher.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            cmd_launcher = tool_dir / "npm.cmd"
            cmd_launcher.write_text("@echo off\n", encoding="utf-8")
            command = f'"{launcher}" --version'

            with (
                patch(
                    "asyncio.create_subprocess_exec",
                    new_callable=AsyncMock,
                    return_value=process,
                ) as create_exec,
                patch(
                    "asyncio.create_subprocess_shell",
                    new_callable=AsyncMock,
                    return_value=process,
                ) as create_shell,
            ):
                result = await terminal.execute_process_async(
                    command,
                    temp_dir,
                    os.environ.copy(),
                )

        self.assertIs(result, process)
        create_exec.assert_not_awaited()
        create_shell.assert_awaited_once()
        shell_command = create_shell.await_args.args[0]
        self.assertEqual(
            shell_command,
            subprocess.list2cmdline([str(cmd_launcher), "--version"]),
        )

    async def test_read_stream_output_consumes_stream_reader(self):
        terminal = AsyncTerminal.__new__(AsyncTerminal)
        terminal._debug_mode = False
        output = []
        terminal.add_log = output.append

        reader = asyncio.StreamReader()
        reader.feed_data("第一行\nsecond line\n".encode("utf-8"))
        reader.feed_eof()

        await terminal._read_stream_output(reader)

        self.assertEqual(output, ["第一行", "second line"])

    async def test_output_task_callback_retrieves_unexpected_exceptions(self):
        class Process:
            stdout = object()
            stderr = object()
            returncode = None
            pid = 123

        terminal = AsyncTerminal.__new__(AsyncTerminal)
        terminal._debug_mode = False
        terminal._output_tasks = []
        terminal._output_tasks_lock = threading.Lock()
        terminal._read_stream_output = AsyncMock(side_effect=RuntimeError("boom"))
        terminal.remove_process = Mock()

        with patch("core.terminal.app_logger.error") as error:
            tasks = terminal.create_output_tasks(Process())
            await asyncio.sleep(0)
            await asyncio.sleep(0)

        self.assertEqual(error.call_count, 2)
        self.assertTrue(all(task.done() for task in tasks))
        self.assertEqual(terminal._output_tasks, [])


class AppLoggerTests(unittest.TestCase):
    def test_debug_forwards_exc_info(self):
        with patch.object(app_logger.logger, "debug") as debug:
            app_logger.debug("debug message", exc_info=True)

        debug.assert_called_once_with("debug message", exc_info=True)


if __name__ == "__main__":
    unittest.main()
