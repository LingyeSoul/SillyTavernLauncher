import asyncio
import inspect
import queue
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from core.terminal import AsyncTerminal  # noqa: E402
from core.event import UiEvent  # noqa: E402
from ui.components.sync_ui import DataSyncUI  # noqa: E402
from ui.dialogs.agreement_dialog import AgreementDialog  # noqa: E402
from ui.main_ui import UniUI  # noqa: E402


class CapturingPage:
    def __init__(self):
        self.tasks = []

    def run_task(self, handler, *args):
        self.tasks.append((handler, args))


class LogView:
    def __init__(self):
        self.controls = []
        self.update = Mock()


class ClosedPage:
    def run_task(self, handler, *args):
        raise RuntimeError("Event loop is closed")


class UiThreadSafetyTests(unittest.TestCase):
    def test_terminal_worker_only_schedules_ui_batch(self):
        terminal = AsyncTerminal.__new__(AsyncTerminal)
        terminal._log_queue = queue.Queue()
        terminal._log_queue.put("message")
        terminal._stop_event = threading.Event()
        terminal._process_batch = Mock()

        def stop_after_schedule():
            terminal._stop_event.set()

        terminal._schedule_batch_process = Mock(side_effect=stop_after_schedule)

        terminal._start_log_processing_loop()
        deadline = time.monotonic() + 1
        while terminal._log_thread.is_alive() and time.monotonic() < deadline:
            terminal._log_thread.join(timeout=0.02)
        terminal._stop_event.set()
        terminal._log_thread.join(timeout=1)

        terminal._schedule_batch_process.assert_called()
        terminal._process_batch.assert_not_called()

    def test_terminal_never_falls_back_to_worker_ui_mutation(self):
        terminal = AsyncTerminal.__new__(AsyncTerminal)
        terminal._log_queue = queue.Queue()
        terminal._log_queue.put("message")
        terminal._batch_schedule_lock = threading.Lock()
        terminal._batch_scheduled = False
        terminal.view = Mock(page=ClosedPage())
        terminal.is_page_valid = Mock(return_value=True)
        terminal._process_batch = Mock()

        terminal._schedule_batch_process()

        terminal._process_batch.assert_not_called()
        self.assertFalse(terminal._batch_scheduled)
        self.assertEqual(terminal._log_queue.qsize(), 1)

    def test_sync_log_mutation_runs_inside_page_task(self):
        sync_ui = DataSyncUI.__new__(DataSyncUI)
        sync_ui.page = CapturingPage()
        sync_ui._sync_log_view = LogView()

        sync_ui._add_log("scheduled message")

        self.assertEqual(sync_ui._sync_log_view.controls, [])
        self.assertEqual(len(sync_ui.page.tasks), 1)

        handler, args = sync_ui.page.tasks[0]
        asyncio.run(handler(*args))

        self.assertEqual(len(sync_ui._sync_log_view.controls), 1)
        sync_ui._sync_log_view.update.assert_called_once()

    def test_main_view_loader_is_a_coroutine(self):
        self.assertTrue(inspect.iscoroutinefunction(UniUI._load_views_async))

    def test_agreement_countdown_is_a_coroutine(self):
        self.assertTrue(inspect.iscoroutinefunction(AgreementDialog._run_countdown))

    def test_ui_event_coroutines_use_page_event_loop(self):
        event = UiEvent.__new__(UiEvent)
        event.page = CapturingPage()
        event.uni_ui = None

        async def operation():
            return None

        event.run_async_task(operation())

        deadline = time.monotonic() + 1
        while not event.page.tasks and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(event.page.tasks), 1)
        handler, args = event.page.tasks[0]
        asyncio.run(handler(*args))


if __name__ == "__main__":
    unittest.main()
