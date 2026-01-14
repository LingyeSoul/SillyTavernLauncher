import flet as ft
import datetime
import re
import threading
import queue
import time
import os
from utils.logger import app_logger


# ANSI颜色代码正则表达式
ANSI_ESCAPE_REGEX = re.compile(r'\x1b\[[0-9;]*m')
COLOR_MAP = {
    '\x1b[30m': ft.Colors.BLACK,
    '\x1b[31m': ft.Colors.RED,
    '\x1b[32m': ft.Colors.GREEN,
    '\x1b[33m': ft.Colors.YELLOW,
    '\x1b[34m': ft.Colors.BLUE,
    '\x1b[35m': ft.Colors.PURPLE,
    '\x1b[36m': ft.Colors.CYAN,
    '\x1b[37m': ft.Colors.WHITE,
    '\x1b[90m': ft.Colors.GREY,
    '\x1b[91m': ft.Colors.RED_300,
    '\x1b[92m': ft.Colors.GREEN_300,
    '\x1b[93m': ft.Colors.YELLOW_300,
    '\x1b[94m': ft.Colors.BLUE_300,
    '\x1b[95m': ft.Colors.PURPLE_300,
    '\x1b[96m': ft.Colors.CYAN_300,
    '\x1b[97m': ft.Colors.WHITE,
    '\x1b[0m': None,  # 重置代码
    '\x1b[m': None   # 重置代码
}


def parse_ansi_text(text):
    """解析ANSI文本并返回带有颜色样式的TextSpan对象列表"""
    if not text:
        return []

    # 使用正则表达式分割ANSI代码和文本
    parts = ANSI_ESCAPE_REGEX.split(text)
    ansi_codes = ANSI_ESCAPE_REGEX.findall(text)

    spans = []
    current_color = None

    # 第一个部分没有前置的ANSI代码
    if parts and parts[0]:
        spans.append(ft.TextSpan(parts[0], style=ft.TextStyle(color=current_color)))

    # 处理剩余部分和对应的ANSI代码
    for i, part in enumerate(parts[1:]):
        if i < len(ansi_codes):
            ansi_code = ansi_codes[i]
            if ansi_code in COLOR_MAP:
                current_color = COLOR_MAP[ansi_code]

        if part:  # 非空文本部分
            # 创建带颜色的文本片段
            spans.append(ft.TextSpan(part, style=ft.TextStyle(color=current_color)))

    return spans

class AsyncTerminal:
    # 性能优化常量
    MAX_QUEUE_SIZE = 10000  # 增加队列最大条目数
    MAX_LOG_ENTRIES = 150  # 增加UI控件数量限制
    LOG_MAX_LENGTH = 1000  # 单条日志长度限制
    LOG_MAX_LENGTH_DETAILED = 5000  # 详细日志（如traceback）的长度限制
    BATCH_SIZE_THRESHOLD = 30  # 批量处理阈值
    PROCESS_INTERVAL = 0.02  # 处理间隔（20ms）

    # 日志显示和记录分离
    MAX_DISPLAY_LOGS = 150  # 终端最多显示150条
    HIGH_LOAD_THRESHOLD = 500  # 高负载阈值
    OVERLOAD_THRESHOLD = 2000  # 过载阈值

    # 日志文件大小限制（100MB）
    MAX_LOG_FILE_SIZE = 100 * 1024 * 1024

    def __init__(self, page, enable_logging=True, local_enabled=False):
        self.logs = ft.ListView(
            expand=True,
            build_controls_on_demand=True,
            spacing=5,
            auto_scroll=True,
            padding=10
        )
        # 初始化启动时间戳
        self.launch_timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

        # 读取配置以确定是否启用局域网访问
        if page.platform == ft.PagePlatform.WINDOWS:
            # 只在启用局域网访问时获取并显示IP
            try:
                # 尝试导入 network 模块（兼容主程序和测试器）
                try:
                    from network import get_local_ip
                except ImportError:
                    from src.network import get_local_ip

                if local_enabled:
                    local_ip = get_local_ip()
                    title_text = f"局域网IP：{local_ip}"
                else:
                    title_text = ""
            except (ImportError, ModuleNotFoundError):
                # 如果导入失败，跳过IP显示
                title_text = ""
            self.view = ft.Column([
                ft.Row([
                        ft.Text("终端", size=24, weight=ft.FontWeight.BOLD),
                        ft.Text(title_text, size=16, color=ft.Colors.BLUE_300),
                        ], alignment=ft.CrossAxisAlignment.START),

                ft.Container(
                    content=self.logs,
                    border=ft.Border.all(1, ft.Colors.GREY_400),
                    padding=10,
                    width=730,
                    height=440,
                )
            ])

        self.active_processes = []
        self.is_running = False
        self._output_threads = []  # 存储输出处理线程
        self.enable_logging = enable_logging

        # DEBUG 模式控制
        self._debug_mode = False

        # ============ 线程相关变量 ============
        # 日志队列（使用线程安全的队列）
        self._log_queue = queue.Queue(maxsize=10000)
        self._last_process_time = 0
        self._process_interval = 0.02
        self._processing = False
        self._batch_size_threshold = 30
        self._stop_event = threading.Event()
        self._max_log_entries = 1500

        # 日志文件写入线程相关属性
        self._log_file_queue = queue.Queue(maxsize=10000)
        self._log_file_thread = None
        self._log_file_stop_event = threading.Event()
        self._log_file_handle = None  # 文件句柄，保持打开以减少I/O
        self._log_file_lock = threading.Lock()

        # UI更新防抖
        self._update_pending = False
        self._update_lock = threading.Lock()
        self._update_timer = None
        self._last_ui_update = time.time()
        self._is_shutting_down = False

        # ========== 新增：异步任务和进程管理锁 ==========
        self._output_tasks_lock = threading.Lock()  # 保护 _output_tasks 列表
        self._active_processes_lock = threading.Lock()  # 保护 active_processes 列表
        self._ui_update_fail_count = 0
        self._page_ready = False
        self._last_refresh_time = 0
        self._refresh_cooldown = 0.05

        # ========== 新增：线程引用管理 ==========
        self._log_thread = None
        self._log_file_thread = None
        self._cleanup_thread = None
        self._threads_lock = threading.Lock()  # 保护线程列表

        # ========== 新增：定时器跟踪（防止内存泄漏） ==========
        self._active_timers = []  # 跟踪所有活动的定时器
        self._timers_lock = threading.Lock()  # 保护定时器列表

        # ========== 新增：队列非空条件变量 ==========
        self._log_queue_not_empty = threading.Condition()  # 队列非空条件变量

        # 启动日志处理循环
        self._start_log_processing_loop()

        # 启动日志文件写入线程
        if self.enable_logging:
            self._start_log_file_thread()

    # ============ 日志处理循环 ============

    def _start_log_processing_loop(self):
        """启动日志处理循环"""
        def log_processing_worker():
            while not self._stop_event.is_set():
                try:
                    # 检查队列是否有项目
                    if not self._log_queue.empty():
                        self._process_batch()
                    time.sleep(0.02)
                except Exception as e:
                    app_logger.exception("日志处理循环错误")

        # 在单独的线程中运行日志处理循环（保持为 daemon，避免阻塞程序退出）
        self._log_thread = threading.Thread(target=log_processing_worker, daemon=True)
        self._log_thread.start()

    # ============ 日志文件写入线程 ============

    def _start_log_file_thread(self):
        """启动日志文件写入线程"""
        def log_file_worker():
            """日志文件写入工作线程"""
            # 预先打开文件句柄（添加错误处理）
            file_opened = self._open_log_file()
            if not file_opened:
                app_logger.warning("无法打开日志文件，日志文件写入将继续尝试")

            while not self._log_file_stop_event.is_set():
                try:
                    # 批量处理日志文件写入
                    entries = []
                    try:
                        # 先处理一个日志条目
                        entry = self._log_file_queue.get(timeout=0.1)
                        entries.append(entry)

                        # 尝试获取更多日志条目进行批量处理
                        while len(entries) < 100:  # 批量处理100条
                            try:
                                entry = self._log_file_queue.get_nowait()
                                entries.append(entry)
                            except queue.Empty:
                                break
                    except queue.Empty:
                        continue

                    if entries:
                        # 只在文件句柄可用时写入
                        if self._log_file_handle is not None:
                            self._write_log_entries_to_file(entries)

                except Exception as e:
                    app_logger.exception("日志文件写入线程错误")

            # 关闭文件句柄
            self._close_log_file()

        # 启动日志文件写入线程（保持为 daemon，避免阻塞程序退出）
        self._log_file_thread = threading.Thread(target=log_file_worker, daemon=True)
        self._log_file_thread.start()

    # ============ 日志文件操作 ============

    def _open_log_file(self):
        """
        打开日志文件句柄

        Returns:
            bool: 成功返回True，失败返回False
        """
        if not self.enable_logging:
            return True

        try:
            logs_dir = os.path.join(os.getcwd(), "logs")
            os.makedirs(logs_dir, exist_ok=True)
            log_file_path = os.path.join(logs_dir, f"{self.launch_timestamp}.log")

            with self._log_file_lock:
                if self._log_file_handle is None:
                    self._log_file_handle = open(log_file_path, "a", encoding="utf-8", buffering=8192)
            return True
        except Exception as e:
            app_logger.error(f"打开日志文件失败: {str(e)}")
            with self._log_file_lock:
                self._log_file_handle = None
            return False

    def _close_log_file(self):
        """关闭日志文件句柄"""
        with self._log_file_lock:
            if self._log_file_handle:
                try:
                    self._log_file_handle.close()
                except:
                    pass
                self._log_file_handle = None

    def update_log_setting(self, enabled: bool):
        """更新日志设置"""
        self.enable_logging = enabled
        if not enabled:
            self._close_log_file()
        else:
            self._open_log_file()

    def _get_current_log_file_size(self):
        """获取当前日志文件的大小"""
        if self._log_file_handle:
            try:
                return self._log_file_handle.tell()
            except:
                try:
                    log_file_path = os.path.join(os.getcwd(), "logs", f"{self.launch_timestamp}.log")
                    return os.path.getsize(log_file_path) if os.path.exists(log_file_path) else 0
                except:
                    return 0
        return 0

    def _rotate_log_file_if_needed(self):
        """检查是否需要轮转日志文件"""
        if self._get_current_log_file_size() >= self.MAX_LOG_FILE_SIZE:
            self._close_log_file()
            self.launch_timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            if self._open_log_file():
                self.add_log(f"[INFO] 日志文件轮转到新文件: {self.launch_timestamp}.log")
            else:
                self.add_log("[WARNING] 日志文件轮转失败，无法打开新的日志文件")

    def _verify_process_running(self, pid):
        """使用 tasklist 验证进程是否仍在运行"""
        import subprocess
        try:
            result = subprocess.run(
                ['tasklist', '/FI', f'PID eq {pid}', '/FO', 'CSV'],
                capture_output=True,
                text=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
                encoding='gbk',
                errors='ignore'
            )

            self.add_log(f"[DEBUG] 验证 PID={pid}: tasklist 返回码={result.returncode}")
            if result.stdout:
                self.add_log(f"[DEBUG] tasklist 输出: {result.stdout[:200]}")

            is_running = str(pid) in result.stdout and result.returncode == 0
            self.add_log(f"[DEBUG] PID={pid} 是否运行: {is_running}")
            return is_running
        except Exception as e:
            self.add_log(f"[DEBUG] 验证 PID={pid} 时出错: {str(e)}")
            return False

    def _kill_process_by_pid(self, pid, use_tree=True):
        """使用 taskkill 强制杀死指定 PID 的进程"""
        import subprocess
        try:
            cmd = ['taskkill', '/F', '/PID', str(pid)]
            if use_tree:
                cmd.append('/T')

            result = subprocess.run(
                cmd,
                capture_output=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
                text=True,
                encoding='gbk',
                errors='ignore'
            )

            return result.returncode in [0, 1]
        except Exception:
            return False

    # ============ 批处理方法（使用旧版本实现）============

    def _process_batch(self):
        """处理批量日志条目"""
        if self._processing:
            return

        current_time = time.time()
        queue_size = self._log_queue.qsize()
        time_to_process = (current_time - self._last_process_time) >= self._process_interval
        size_to_process = queue_size >= self._batch_size_threshold

        if not time_to_process and not size_to_process and queue_size > 0:
            size_to_process = True
            batch_limit = min(3, queue_size)
        else:
            batch_limit = min(self._batch_size_threshold, queue_size) if queue_size > 0 else self._batch_size_threshold

        self._processing = True
        try:
            log_entries = []
            processed_count = 0
            while processed_count < batch_limit:
                try:
                    entry = self._log_queue.get_nowait()
                    log_entries.append(entry)
                    processed_count += 1
                except queue.Empty:
                    break

            if not log_entries:
                return

            # ========== 新增：检查页面是否有效，避免在页面无效时添加控件 ==========
            if not self.is_page_valid():
                # 页面无效，丢弃这些日志（但已从队列中取出，避免积累）
                if self._debug_mode:
                    print(f"[DEBUG] 页面无效，丢弃了 {len(log_entries)} 条日志")
                return

            # 创建日志控件
            new_controls = []
            for processed_text in log_entries:
                if ANSI_ESCAPE_REGEX.search(processed_text):
                    spans = parse_ansi_text(processed_text)
                    new_text = ft.Text(spans=spans, selectable=True, size=14)
                else:
                    new_text = ft.Text(processed_text, selectable=True, size=14)
                new_controls.append(new_text)

            # 批量更新日志控件
            self.logs.controls.extend(new_controls)

            # 限制日志数量
            if len(self.logs.controls) > self._max_log_entries:
                del self.logs.controls[:-self._max_log_entries//2]

            # ========== 新增：在更新 UI 之前再次检查页面有效性 ==========
            # 因为我们是异步执行，页面状态可能在等待期间发生变化
            if not self.is_page_valid():
                # 页面变为无效，清除刚才添加的控件
                # 保留最后20条
                if len(self.logs.controls) > 20:
                    del self.logs.controls[:-20]
                # 确保至少有一个控件
                if len(self.logs.controls) == 0:
                    self.logs.controls.append(ft.Text("", size=14))
                return

            self._last_process_time = current_time

            # 批量更新UI（添加完善的错误处理）
            try:
                if hasattr(self, 'view') and self.view is not None:
                    page = self.view.page  # 可能抛出 RuntimeError
                    if page is not None:
                        self.logs.update()
            except (AssertionError, RuntimeError, AttributeError) as e:
                # 控件树问题或控件已从页面移除，忽略但记录
                if self._debug_mode:
                    import traceback
                    print(f"[DEBUG] UI更新失败（预期错误）: {str(e)}")
            except Exception as e:
                # 捕获所有其他异常（这些可能导致灰屏）
                app_logger.exception("UI更新时发生未预期错误（可能导致灰屏）")
                # 尝试恢复：确保至少有一个控件
                try:
                    if hasattr(self, 'logs') and self.logs:
                        if len(self.logs.controls) == 0:
                            self.logs.controls.append(ft.Text("界面渲染错误，请刷新页面", size=14, color=ft.Colors.RED))
                            # 尝试强制更新
                            if hasattr(self, 'view') and self.view is not None:
                                try:
                                    page = self.view.page
                                    if page is not None:
                                        self.logs.update()
                                except:
                                    pass
                except:
                    pass

        except Exception as e:
            app_logger.exception("批量处理失败")
        finally:
            self._processing = False
            if not self._log_queue.empty():
                self._schedule_batch_process()

    def _schedule_batch_process(self):
        """安排批量处理 - 改进版，减少阻塞，确保队列能被处理"""
        # 快速检查页面是否可用
        if not self.is_page_valid():
            # 页面暂时不可用，保留最近10条日志，其余丢弃以避免积累
            try:
                preserved = []
                discard_count = 0
                while not self._log_queue.empty():
                    try:
                        entry = self._log_queue.get_nowait()
                        if len(preserved) < 10:
                            preserved.append(entry)
                        else:
                            discard_count += 1
                    except:
                        break

                # 将保留的日志放回队列
                for entry in preserved:
                    try:
                        self._log_queue.put_nowait(entry)
                    except:
                        pass

                if discard_count > 0:
                    print(f"[INFO] 页面不可用，丢弃了 {discard_count} 条日志")
            except:
                pass
            return

        try:
            page = self.view.page
            if page is None:
                return

            # 定义异步处理函数
            async def async_process_batch():
                # 在异步任务中处理批量更新
                try:
                    self._process_batch()
                except Exception as e:
                    # 捕获并记录所有异常，避免导致灰屏
                    app_logger.exception("批量处理失败（同步阶段）")

            # 尝试异步调度，失败则使用同步处理
            try:
                page.run_task(async_process_batch)
            except RuntimeError as e:
                error_msg = str(e)
                # 只在事件循环真正关闭时跳过
                if "Event loop is closed" in error_msg:
                    # 事件循环已关闭，直接同步处理（如果可能）
                    try:
                        self._process_batch()
                    except:
                        # 同步处理也失败，保留最近10条日志
                        preserved = []
                        discard_count = 0
                        while not self._log_queue.empty():
                            try:
                                entry = self._log_queue.get_nowait()
                                if len(preserved) < 10:
                                    preserved.append(entry)
                                else:
                                    discard_count += 1
                            except:
                                break

                        # 将保留的日志放回队列
                        for entry in preserved:
                            try:
                                self._log_queue.put_nowait(entry)
                            except:
                                pass

                        if discard_count > 0:
                            app_logger.info(f"事件循环已关闭，丢弃了 {discard_count} 条日志")
                    return
                # 其他 RuntimeError 仍然记录但继续尝试同步处理
                app_logger.warning(f"调度批量处理遇到 RuntimeError: {error_msg}，尝试同步处理")
                try:
                    self._process_batch()
                except Exception as sync_error:
                    app_logger.error(f"同步处理也失败: {sync_error}")
                return
            except Exception as e:
                # 记录其他异常并尝试同步处理
                app_logger.exception("调度批量处理时发生未预期错误")
                try:
                    self._process_batch()
                except Exception as sync_error:
                    app_logger.error(f"同步处理也失败: {sync_error}")
                return

            return
        except (RuntimeError, AttributeError) as e:
            # 控件已从页面移除或 page 属性访问失败
            app_logger.exception("访问页面属性失败")
            return
        except Exception as e:
            # 捕获所有其他异常
            app_logger.exception("_schedule_batch_process 发生未预期错误")

        return

    # ============ 进程管理 ============

    def cleanup_finished_tasks(self):
        """清理已完成的异步任务"""
        with self._output_tasks_lock:
            if not hasattr(self, '_output_tasks'):
                return

            # 保留未完成的任务，移除已完成/取消的任务
            active_tasks = [
                task for task in self._output_tasks
                if not task.done() and not task.cancelled()
            ]

            cleaned_count = len(self._output_tasks) - len(active_tasks)
            if cleaned_count > 0:
                self._output_tasks = active_tasks
                if self._debug_mode:
                    self.add_log(f"[DEBUG] 清理了 {cleaned_count} 个已完成的任务")

    def aggressive_cleanup(self):
        """激进的内存清理：清理任务、进程和日志控件"""
        # 1. 清理已完成的任务
        self.cleanup_finished_tasks()

        # 2. 清理已结束的进程
        with self._active_processes_lock:
            active_processes = []
            for proc_info in self.active_processes:
                process = proc_info.get('process')
                # 检查进程是否仍在运行
                is_running = False
                if hasattr(process, 'poll'):
                    is_running = process.poll() is None
                elif hasattr(process, 'returncode'):
                    is_running = process.returncode is None

                if is_running:
                    active_processes.append(proc_info)

            cleaned_count = len(self.active_processes) - len(active_processes)
            if cleaned_count > 0 and self._debug_mode:
                self.add_log(f"[DEBUG] 清理了 {cleaned_count} 个已结束的进程")
            self.active_processes = active_processes

        # 3. 激进地清理日志控件（保留更少的历史）
        if len(self.logs.controls) > 100:  # 只保留100条
            old_count = len(self.logs.controls)
            del self.logs.controls[:-100]
            if self._debug_mode:
                self.add_log(f"[DEBUG] 清理了 {old_count - 100} 个日志控件")


            # 强制更新UI（仅在页面有效时）
            try:
                if self.is_page_valid():
                    self.logs.update()
            except (RuntimeError, AttributeError):
                pass  # 控件已从页面移除或页面无效，忽略更新

    # ============ 定时器管理（防止内存泄漏） ============

    def _create_timer(self, interval, function, args=None, kwargs=None):
        """创建定时器并跟踪它，防止内存泄漏"""
        import threading

        timer = threading.Timer(
            interval,
            function,
            args=args if args is not None else (),
            kwargs=kwargs if kwargs is not None else {}
        )
        timer.daemon = True

        # 跟踪定时器
        with self._timers_lock:
            self._active_timers.append(timer)

        return timer

    def _cleanup_timers(self):
        """清理所有活动的定时器"""
        with self._timers_lock:
            if not self._active_timers:
                return 0

            count = len(self._active_timers)

            # 取消并清理所有定时器
            for timer in self._active_timers:
                try:
                    if timer.is_alive():
                        timer.cancel()
                except Exception:
                    pass

            self._active_timers.clear()

        return count

    def stop_processes(self):
        """
        停止所有进程（异步入口方法）

        注意：此方法返回协程对象，需要在异步上下文中调用。
        如果在 UI 上下文中调用，请使用 page.run_task() 调用此方法。

        Returns:
            asyncio.Task 或 coroutine: 可以被 await 的协程对象
        """
        return self._stop_processes_impl_async()

    def stop_processes_sync(self):
        """
        同步停止所有进程（强制终止，用于程序退出时）

        此方法会强制终止所有进程，不等待优雅退出。
        主要用于程序退出时快速清理资源。
        """
        import signal

        # 使用锁获取进程列表
        with self._active_processes_lock:
            if not self.active_processes:
                return False
            processes_to_stop = self.active_processes[:]  # 创建副本
            self.active_processes = []  # 立即清空原列表

        self.add_log(f"强制终止 {len(processes_to_stop)} 个进程...")

        # 清理所有定时器
        timer_count = self._cleanup_timers()
        if timer_count > 0:
            self.add_log(f"  清理了 {timer_count} 个定时器")

        # 设置停止事件
        self._stop_event.set()
        self._log_file_stop_event.set()

        # 强制终止所有进程
        for proc_info in processes_to_stop:
            try:
                pid = proc_info['pid']
                process = proc_info.get('process')
                command = proc_info.get('command', '')

                self.add_log(f"终止进程 PID={pid}: {command[:50]}")

                # 直接强制终止（SIGKILL）
                try:
                    if hasattr(process, 'kill'):
                        process.kill()
                    elif hasattr(process, 'send_signal'):
                        process.send_signal(signal.SIGKILL)
                except Exception:
                    pass

            except Exception as ex:
                error_msg = str(ex).strip()
                if error_msg:
                    self.add_log(f"终止进程 {proc_info['pid']} 时出错: {error_msg}")

        self.add_log("✓ 所有进程已终止")

        # 清理所有资源
        try:
            self.cleanup_all_resources(aggressive=True)
        except Exception as e:
            self.add_log(f"[WARNING] 资源清理时出错: {str(e)}")

        # 停止周期性清理定时器
        self.stop_periodic_cleanup()

        self.is_running = False
        self._stop_event.clear()

        return True

    async def _stop_processes_impl_async(self):
        """
        停止所有进程的异步实现（多阶段终止策略）

        使用 asyncio.sleep() 替代 time.sleep()，避免阻塞事件循环。
        此方法是非阻塞的，可以在 UI 线程的异步上下文中安全运行。
        """
        import asyncio
        import signal
        # ========== 使用锁获取进程列表 ==========
        with self._active_processes_lock:
            if not self.active_processes:
                return False
            processes_to_stop = self.active_processes[:]  # 创建副本
            self.active_processes = []  # 立即清空原列表

        self.add_log(f"正在终止 {len(processes_to_stop)} 个进程...")

        # ========== 清理所有定时器（防止内存泄漏） ==========
        timer_count = self._cleanup_timers()
        if timer_count > 0:
            self.add_log(f"  清理了 {timer_count} 个定时器")

        # 刷新日志缓冲区（添加异常处理）
        try:
            self._flush_log_buffer()
        except Exception as e:
            self.add_log(f"[WARNING] 刷新日志缓冲区失败: {e}")

        # 设置停止事件
        self._stop_event.set()
        self._log_file_stop_event.set()

        # ========== 等待日志处理线程退出（短超时，避免阻塞UI） ==========
        if hasattr(self, '_log_thread') and self._log_thread:
            if self._log_thread.is_alive():
                self._log_thread.join(timeout=0.1)
            self._log_thread = None

        # ========== 等待日志文件写入线程退出（短超时，避免阻塞UI） ==========
        if hasattr(self, '_log_file_thread') and self._log_file_thread:
            if self._log_file_thread.is_alive():
                self._log_file_thread.join(timeout=0.1)
            self._log_file_thread = None

        # 停止所有输出线程
        for thread in self._output_threads:
            if thread.is_alive():
                thread.join(timeout=2.0)

        self._output_threads = []

        # 停止所有异步任务
        if hasattr(self, '_output_tasks'):
            with self._output_tasks_lock:  # ========== 新增：使用锁 ==========
                for task in self._output_tasks:
                    if not task.done():
                        task.cancel()
                self._output_tasks = []

        import signal

        # 阶段 1 & 2: 优雅终止 + 强制终止
        for proc_info in processes_to_stop:  # ========== 修改：使用副本 ==========
            try:
                pid = proc_info['pid']
                process = proc_info.get('process')
                command = proc_info.get('command', '')

                self.add_log(f"终止进程 PID={pid}: {command[:50]}")

                # 检查进程是否仍在运行
                is_running = False
                if hasattr(process, 'poll'):
                    is_running = process.poll() is None
                elif hasattr(process, 'returncode'):
                    is_running = process.returncode is None

                if not is_running:
                    self.add_log(f"  进程 PID={pid} 已停止")
                    continue

                # 阶段 1: 优雅终止（SIGTERM）
                try:
                    if hasattr(process, 'terminate'):
                        process.terminate()
                    elif hasattr(process, 'send_signal'):
                        process.send_signal(signal.SIGTERM)
                except Exception:
                    pass

                # 等待优雅退出（最多2秒）
                for _ in range(20):
                    await asyncio.sleep(0.1)
                    if hasattr(process, 'poll') and process.poll() is not None:
                        break
                    elif hasattr(process, 'returncode') and process.returncode is not None:
                        break

                # 阶段 2: 强制终止（SIGKILL）
                is_running = False
                if hasattr(process, 'poll'):
                    is_running = process.poll() is None
                elif hasattr(process, 'returncode'):
                    is_running = process.returncode is None

                if is_running:
                    self.add_log(f"  进程 PID={pid} 优雅退出失败，强制终止...")
                    try:
                        if hasattr(process, 'kill'):
                            process.kill()
                        elif hasattr(process, 'send_signal'):
                            process.send_signal(signal.SIGKILL)
                    except Exception:
                        pass

                    # 等待强制终止生效（最多1秒）
                    for _ in range(10):
                        await asyncio.sleep(0.1)
                        if hasattr(process, 'poll') and process.poll() is not None:
                            break
                        elif hasattr(process, 'returncode') and process.returncode is not None:
                            break

            except Exception as ex:
                error_msg = str(ex).strip()
                if error_msg:
                    self.add_log(f"终止进程 {proc_info['pid']} 时出错: {error_msg}")

        self.add_log("✓ 所有进程已终止")

        # ========== 新增：执行全面资源清理 ==========
        try:
            cleanup_stats = self.cleanup_all_resources(aggressive=True)
            # 只在 DEBUG 模式下显示详细清理统计
            if self._debug_mode:
                self.add_log(
                    f"[DEBUG] [清理] 任务={cleanup_stats['tasks_cleaned']}, "
                    f"额外进程={cleanup_stats['processes_cleaned']}, "
                    f"线程={cleanup_stats['threads_cleaned']}, "
                    f"定时器={cleanup_stats['timers_cleaned']}, "
                    f"队列={cleanup_stats['queues_cleared']}, "
                    f"UI控件={cleanup_stats['ui_controls_cleaned']}, "
                    f"内存释放={cleanup_stats['memory_freed']}KB"
                )
        except Exception as e:
            self.add_log(f"[WARNING] 资源清理时出错: {str(e)}")

        # 停止周期性清理定时器
        self.stop_periodic_cleanup()

        self.is_running = False
        self._stop_event.clear()

        return True

    # ============ 公共API方法 ============

    def create_process(self, process, pid, command):
        """
        创建并注册新进程（线程安全）

        Args:
            process: asyncio.subprocess.Process 对象
            pid: 进程ID
            command: 执行的命令字符串

        Returns:
            dict: 进程信息字典
        """
        proc_info = {
            'process': process,
            'pid': pid,
            'command': command,
            'created_at': time.time()
        }

        with self._active_processes_lock:
            self.active_processes.append(proc_info)

        if self._debug_mode:
            self.add_log(f"[DEBUG] 注册进程 PID={pid}, 总进程数={len(self.active_processes)}")
        return proc_info

    def remove_process(self, pid):
        """
        移除已结束的进程（线程安全）

        Args:
            pid: 要移除的进程ID

        Returns:
            bool: 是否成功移除
        """
        with self._active_processes_lock:
            original_count = len(self.active_processes)
            self.active_processes = [
                p for p in self.active_processes if p['pid'] != pid
            ]
            removed = len(self.active_processes) < original_count

        if removed and self._debug_mode:
            self.add_log(f"[DEBUG] 移除进程 PID={pid}")

        return removed

    async def execute_process_async(self, command, workdir, env):
        """
        异步执行进程并管理其生命周期

        Args:
            command: 命令字符串
            workdir: 工作目录
            env: 环境变量字典

        Returns:
            asyncio.subprocess.Process or None: 进程对象，失败时返回 None
        """
        import asyncio
        import subprocess
        import os
        import shlex

        process = None
        try:
            self.add_log(f"{workdir} $ {command}")

            # 解析命令
            args = shlex.split(command, posix=False)
            if not args:
                raise ValueError("命令解析为空")

            executable = args[0].strip('"').strip("'")
            cmd_args = args[1:]

            if self._debug_mode:
                self.add_log(f"[DEBUG] 可执行文件: {executable}")
                self.add_log(f"[DEBUG] 参数: {cmd_args}")

            # 验证可执行文件
            use_shell = False
            if not os.path.isfile(executable):
                # 在 Windows 上，如果路径没有扩展名，尝试添加常见扩展名
                if '.' not in os.path.basename(executable):
                    extensions = ['.exe', '.cmd', '.bat', '.ps1']
                    for ext in extensions:
                        if os.path.isfile(executable + ext):
                            executable = executable + ext
                            if self._debug_mode:
                                self.add_log(f"[DEBUG] 自动添加扩展名: {ext}")
                            break
                if not os.path.isfile(executable):
                    raise FileNotFoundError(f"找不到可执行文件: {executable}")

            # 检测是否为批处理文件，直接使用 shell 方式
            if executable.lower().endswith(('.cmd', '.bat')):
                use_shell = True
                if self._debug_mode:
                    self.add_log(f"[DEBUG] 检测到批处理文件，使用 shell 方式")

            # 创建进程
            if not use_shell:
                try:
                    process = await asyncio.create_subprocess_exec(
                        executable, *cmd_args,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        cwd=workdir,
                        env=env,
                        creationflags=subprocess.CREATE_NO_WINDOW
                    )
                except Exception as e:
                    # 回退到 shell 方式
                    self.add_log(f"[DEBUG] 执行失败，使用 shell 方式: {str(e)}")
                    process = await asyncio.create_subprocess_shell(
                        command,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        cwd=workdir,
                        env=env,
                        creationflags=subprocess.CREATE_NO_WINDOW
                    )
            else:
                # 批处理文件，直接使用 shell 方式
                process = await asyncio.create_subprocess_shell(
                    command,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=workdir,
                    env=env,
                    creationflags=subprocess.CREATE_NO_WINDOW
                )

            # 注册进程
            self.create_process(process, process.pid, command)

            return process

        except Exception as e:
            import traceback
            error_msg = f"创建进程失败: {str(e)}\n{traceback.format_exc()}"
            self.add_log(error_msg)

            # 清理失败的进程
            if process:
                try:
                    if process.returncode is None:
                        process.terminate()
                        await asyncio.sleep(0.5)
                        if process.returncode is None:
                            process.kill()
                except Exception:
                    pass

            return None

    async def _read_stream_output(self, stream, is_stderr=False):
        """
        异步读取进程输出（重构版：使用 StreamReader，简化逻辑）

        Args:
            stream: 输入流（stdout 或 stderr）
            is_stderr: 是否为错误流（用于调试标识）

        重构说明：
        - 使用 asyncio StreamReader 的 readline() 方法，更简单可靠
        - 移除复杂的缓冲区管理和自适应逻辑
        - 确保流在结束时被正确关闭
        - 减少内存泄漏风险
        - 处理超长行导致的 ValueError: Separator is found, but chunk is longer than limit
        """
        import asyncio

        # 记录流类型（用于调试）
        stream_type = "STDERR" if is_stderr else "STDOUT"
        if self._debug_mode:
            self.add_log(f"[DEBUG] 开始读取 {stream_type} 流")

        try:
            # 使用 readline() 逐行读取，自动处理缓冲
            while True:
                try:
                    # 读取一行（自动处理换行符和缓冲）
                    line = await asyncio.wait_for(stream.readline(), timeout=0.1)

                    if not line:
                        # 空行表示流结束
                        if stream.at_eof():
                            break
                        continue

                    # 解码并清理
                    try:
                        decoded_line = line.decode('utf-8', errors='replace').rstrip('\r\n')
                        if decoded_line:  # 只输出非空行
                            self.add_log(decoded_line)
                    except Exception as decode_error:
                        if self._debug_mode:
                            self.add_log(f"[DEBUG] 解码错误: {decode_error}")

                except asyncio.TimeoutError:
                    # 超时不是错误，继续等待
                    if stream.at_eof():
                        break
                    continue

                except ValueError as line_error:
                    # 处理超长行错误: "Separator is found, but chunk is longer than limit"
                    # 当输出行超过 StreamReader 的默认限制（64KB）时触发
                    if "chunk is longer than limit" in str(line_error):
                        # 使用 read() 读取固定大小的块来处理超长行
                        try:
                            chunk = await asyncio.wait_for(stream.read(8192), timeout=0.1)
                            if chunk:
                                decoded_chunk = chunk.decode('utf-8', errors='replace')
                                self.add_log(decoded_chunk.rstrip('\r\n'))
                            elif stream.at_eof():
                                break
                        except asyncio.TimeoutError:
                            if stream.at_eof():
                                break
                    else:
                        # 其他 ValueError，向上抛出
                        raise

        except asyncio.CancelledError:
            # 任务被取消，正常退出
            if self._debug_mode:
                self.add_log(f"[DEBUG] 输出读取任务被取消")

        except Exception as ex:
            # 记录错误但不中断
            try:
                if hasattr(self, 'view') and self.view is not None:
                    page = self.view.page  # 可能抛出 RuntimeError
                    if page is not None:
                        self.add_log(f"输出处理错误: {type(ex).__name__}: {str(ex)}")
            except (RuntimeError, AttributeError):
                pass  # 控件已从页面移除，忽略

        finally:
            # 确保流被关闭
            try:
                if stream and not stream.is_closing():
                    stream.close()
            except Exception:
                pass

    def create_output_tasks(self, process):
        """
        创建并注册输出处理任务（由 terminal 完全管理）

        Args:
            process: asyncio.subprocess.Process 对象

        Returns:
            tuple: (stdout_task, stderr_task)
        """
        import asyncio

        # 创建输出处理协程（使用 terminal 自己的方法）
        stdout_coroutine = self._read_stream_output(process.stdout, False)
        stderr_coroutine = self._read_stream_output(process.stderr, True)

        stdout_task = asyncio.create_task(stdout_coroutine)
        stderr_task = asyncio.create_task(stderr_coroutine)

        # 注册任务
        with self._output_tasks_lock:
            if not hasattr(self, '_output_tasks'):
                self._output_tasks = []
            self._output_tasks.extend([stdout_task, stderr_task])

        # ========== 关键改进：使用 weakref 避免循环引用 ==========
        import weakref

        # 使用弱引用避免回调函数持有 process 的强引用
        process_weak_ref = weakref.ref(process) if process else None
        terminal_weak_ref = weakref.ref(self)

        def on_task_done(task):
            """任务完成回调 - 使用弱引用避免循环引用"""
            import time
            try:
                # 通过弱引用获取对象
                term_ref = terminal_weak_ref() if terminal_weak_ref else None
                proc_ref = process_weak_ref() if process_weak_ref else None

                if not term_ref:
                    return  # terminal 已被销毁

                if term_ref._debug_mode:
                    term_ref.add_log(f"[DEBUG] 任务完成回调触发: task={task}, done={task.done()}, cancelled={task.cancelled()}")

                # 清理已完成的任务
                before_count = len(term_ref._output_tasks)
                term_ref.cleanup_finished_tasks()
                after_count = len(term_ref._output_tasks)

                if term_ref._debug_mode and before_count != after_count:
                    term_ref.add_log(f"[DEBUG] 任务清理: {before_count} -> {after_count}")

                # 如果进程存在，等待一小段时间让它有机会更新 returncode
                if proc_ref and proc_ref.returncode is None:
                    # 最多等待 0.5 秒，检查进程是否结束
                    for _ in range(10):
                        time.sleep(0.05)
                        if proc_ref.returncode is not None:
                            break

                # 如果进程已结束，移除进程引用
                # 注意：StreamReader 会自动关闭，无需手动关闭
                if proc_ref and proc_ref.returncode is not None:
                    if term_ref._debug_mode:
                        term_ref.add_log(f"[DEBUG] 进程已结束 (PID={proc_ref.pid}, returncode={proc_ref.returncode})")

                    # 移除进程引用（添加重试机制）
                    max_retries = 3
                    for attempt in range(max_retries):
                        removed = term_ref.remove_process(proc_ref.pid)
                        if removed:
                            if term_ref._debug_mode:
                                term_ref.add_log(f"[DEBUG] 已移除进程 PID={proc_ref.pid}")
                            break
                        elif attempt < max_retries - 1:
                            time.sleep(0.1)
                        else:
                            if term_ref._debug_mode:
                                term_ref.add_log(f"[WARNING] 未能移除进程 PID={proc_ref.pid}")
                elif term_ref._debug_mode and proc_ref:
                    term_ref.add_log(f"[DEBUG] 进程仍在运行 (PID={proc_ref.pid})")

            except Exception as e:
                # 记录回调中的错误（不再静默忽略）
                import traceback
                term_ref = terminal_weak_ref() if terminal_weak_ref else None
                if term_ref:
                    error_msg = f"[ERROR] 任务完成回调失败: {str(e)}\n{traceback.format_exc()}"
                    term_ref.add_log(error_msg)

        # 使用回调函数（传递任务作为参数）
        stdout_task.add_done_callback(on_task_done)
        stderr_task.add_done_callback(on_task_done)

        return stdout_task, stderr_task

    def get_active_processes_count(self):
        """获取当前活动进程数量（线程安全）"""
        with self._active_processes_lock:
            return len(self.active_processes)

    def get_active_tasks_count(self):
        """获取当前活动任务数量（线程安全）"""
        with self._output_tasks_lock:
            if not hasattr(self, '_output_tasks'):
                return 0
            return len([t for t in self._output_tasks if not t.done() and not t.cancelled()])

    def cleanup_all_resources(self, aggressive=False):
        """
        激进的资源清理方法 - 清理所有可能的资源泄漏

        Args:
            aggressive (bool): 是否使用激进模式（强制清理所有资源）

        Returns:
            dict: 清理统计信息
        """
        import gc

        stats = {
            'tasks_cleaned': 0,
            'processes_cleaned': 0,
            'threads_cleaned': 0,
            'queues_cleared': 0,
            'memory_freed': 0
        }

        if self._debug_mode:
            self.add_log("[CLEANUP] 开始全面资源清理...")

        # 1. 清理已完成的任务
        with self._output_tasks_lock:
            if hasattr(self, '_output_tasks'):
                original_count = len(self._output_tasks)

                if aggressive:
                    # 激进模式：取消所有任务
                    for task in self._output_tasks:
                        if not task.done() and not task.cancelled():
                            task.cancel()
                    self._output_tasks = []
                else:
                    # 温和模式：只清理已完成的任务
                    self._output_tasks = [
                        task for task in self._output_tasks
                        if not task.done() and not task.cancelled()
                    ]

                stats['tasks_cleaned'] = original_count - len(self._output_tasks)

        # 2. 清理已结束的进程
        with self._active_processes_lock:
            if hasattr(self, 'active_processes'):
                original_count = len(self.active_processes)
                active_processes = []

                for proc_info in self.active_processes:
                    process = proc_info.get('process')
                    if process:
                        try:
                            # 检查进程是否已结束
                            if process.returncode is not None:
                                # 进程已结束，关闭流
                                try:
                                    if process.stdout:
                                        process.stdout.close()
                                    if process.stderr:
                                        process.stderr.close()
                                except Exception:
                                    pass
                                stats['processes_cleaned'] += 1
                            else:
                                # 进程仍在运行
                                if aggressive:
                                    # 激进模式：强制终止
                                    try:
                                        process.terminate()
                                        import time
                                        time.sleep(0.5)
                                        if process.returncode is None:
                                            process.kill()
                                        stats['processes_cleaned'] += 1
                                    except Exception:
                                        pass
                                else:
                                    # 保留活动进程
                                    active_processes.append(proc_info)
                        except Exception:
                            # 进程对象无效，移除
                            stats['processes_cleaned'] += 1
                    else:
                        # 无效的进程信息，移除
                        stats['processes_cleaned'] += 1

                self.active_processes = active_processes

        # 3. 清理输出线程
        if hasattr(self, '_output_threads'):
            original_count = len(self._output_threads)
            alive_threads = []

            for thread in self._output_threads:
                if thread.is_alive():
                    alive_threads.append(thread)
                else:
                    stats['threads_cleaned'] += 1

            self._output_threads = alive_threads

        # 3.5. 清理所有定时器（防止内存泄漏）
        timer_count = self._cleanup_timers()
        if timer_count > 0:
            stats['timers_cleaned'] = timer_count
        else:
            stats['timers_cleaned'] = 0

        # 4. 清理日志队列（如果队列过大）
        if hasattr(self, '_log_queue'):
            try:
                queue_size = self._log_queue.qsize()
                if queue_size > 1000:  # 队列超过1000条时清理
                    # 清空队列
                    while not self._log_queue.empty():
                        try:
                            self._log_queue.get_nowait()
                        except:
                            break
                    stats['queues_cleared'] = queue_size
            except Exception:
                pass

        # 5. 强制垃圾回收
        try:
            before_memory = self.get_memory_usage()
            gc.collect()
            after_memory = self.get_memory_usage()
            stats['memory_freed'] = before_memory - after_memory
        except Exception:
            pass

        # 6. 清理 UI 控件（激进模式）
        stats['ui_controls_cleaned'] = 0
        if aggressive:
            try:
                before_count = len(self.logs.controls) if hasattr(self, 'logs') and self.logs else 0
                self.cleanup_ui_controls()
                after_count = len(self.logs.controls) if hasattr(self, 'logs') and self.logs else 0
                # 计算实际清理数量（使用 max 避免负数）
                stats['ui_controls_cleaned'] = max(0, before_count - after_count)
            except Exception:
                pass

        # 7. 启动周期性清理定时器（如果尚未启动）
        if not hasattr(self, '_cleanup_timer_started'):
            self._start_periodic_cleanup()

        if self._debug_mode:
            self.add_log(
                f"[CLEANUP] 清理完成: "
                f"任务={stats['tasks_cleaned']}, "
                f"进程={stats['processes_cleaned']}, "
                f"线程={stats['threads_cleaned']}, "
                f"定时器={stats['timers_cleaned']}, "
                f"队列={stats['queues_cleared']}, "
                f"内存={stats['memory_freed']:.1f}MB, "
                f"UI控件={stats['ui_controls_cleaned']}"
            )

        return stats

    def get_memory_usage(self):
        """获取当前进程的内存使用量（MB）"""
        try:
            import psutil
            import os
            process = psutil.Process(os.getpid())
            return process.memory_info().rss / 1024 / 1024
        except Exception:
            return 0.0

    def _start_periodic_cleanup(self):
        """启动周期性清理定时器"""
        import threading
        import time

        if hasattr(self, '_cleanup_thread') and self._cleanup_thread and self._cleanup_thread.is_alive():
            return  # 已经启动

        self._cleanup_timer_started = True

        def periodic_cleanup():
            """每60秒执行一次清理"""
            while hasattr(self, '_cleanup_timer_started') and self._cleanup_timer_started:
                try:
                    time.sleep(60)  # 60秒间隔
                    if hasattr(self, '_cleanup_timer_started') and self._cleanup_timer_started:
                        if self._debug_mode:
                            self.add_log("[PERIODIC] 执行周期性清理...")
                        self.cleanup_all_resources(aggressive=False)
                except Exception as e:
                    self.add_log(f"[ERROR] 周期性清理失败: {str(e)}")

        # 启动后台清理线程（保持为 daemon，避免阻塞程序退出）
        self._cleanup_thread = threading.Thread(target=periodic_cleanup, daemon=True)
        self._cleanup_thread.start()
        if self._debug_mode:
            self.add_log("[CLEANUP] 周期性清理定时器已启动 (间隔: 60秒)")

    def stop_periodic_cleanup(self):
        """停止周期性清理定时器"""
        if hasattr(self, '_cleanup_timer_started'):
            self._cleanup_timer_started = False

        # 等待清理线程结束（短超时，避免阻塞UI）
        if hasattr(self, '_cleanup_thread') and self._cleanup_thread:
            if self._cleanup_thread.is_alive():
                self._cleanup_thread.join(timeout=0.1)
            self._cleanup_thread = None

    def __del__(self):
        """
        析构函数 - 确保对象销毁时清理所有资源

        注意：Python 不保证 __del__ 一定会被调用，所以不应依赖它进行关键清理
        """
        try:
            # 清理所有定时器
            if hasattr(self, '_active_timers'):
                self._cleanup_timers()

            # 停止周期性清理
            if hasattr(self, '_cleanup_timer_started'):
                self._cleanup_timer_started = False

            # 停止日志处理线程
            if hasattr(self, '_log_thread') and self._log_thread:
                if self._log_thread.is_alive():
                    self._stop_event.set()

            # 停止日志文件写入线程
            if hasattr(self, '_log_file_thread') and self._log_file_thread:
                if self._log_file_thread.is_alive():
                    self._log_file_stop_event.set()

            # 关闭文件句柄
            if hasattr(self, '_log_file_handle') and self._log_file_handle:
                try:
                    self._log_file_handle.close()
                except:
                    pass
        except Exception:
            # 析构函数中不应该抛出异常
            pass

    def __enter__(self):
        """支持上下文管理器协议"""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """退出上下文时自动清理资源"""
        try:
            self.stop_processes()
            self.cleanup_all_resources(aggressive=True)
        except Exception as e:
            app_logger.exception("清理资源时出错")
        return False  # 不抑制异常

    def get_resource_stats(self):
        """获取资源统计信息"""
        stats = {
            'processes': self.get_active_processes_count(),
            'tasks': self.get_active_tasks_count(),
            'threads': 0,
            'memory_mb': self.get_memory_usage()
        }

        # 统计活动线程数
        if hasattr(self, '_output_threads'):
            stats['threads'] = len([t for t in self._output_threads if t.is_alive()])

        return stats

    def enable_debug_mode(self, enabled=True):
        """启用或禁用 DEBUG 模式"""
        self._debug_mode = enabled
        if enabled:
            self.add_log("[DEBUG] DEBUG 模式已启用 - 将显示所有调试信息")
        else:
            self.add_log("[DEBUG] DEBUG 模式已禁用 - 将隐藏调试信息")

    def is_page_valid(self):
        """检查页面引用是否仍然有效"""
        # 放宽检查：只检查 view 和 page 是否存在，不检查 window
        # 因为在某些情况下（页面切换、初始化）window 可能暂时为 None
        # 实际的 UI 更新会在 _process_batch 中进行异常处理
        if not hasattr(self, 'view') or self.view is None:
            return False
        if self.view.page is None:
            return False
        return True

    def safe_update_page(self):
        """安全地更新页面"""
        if not self.is_page_valid():
            return False

        try:
            self.page.update()
            return True
        except RuntimeError as e:
            if "Event loop is closed" in str(e) or "window is closed" in str(e):
                self.page = None
                return False
        except AssertionError:
            # Flet 控件树问题
            return False
        return False

    def cleanup_ui_controls(self):
        """清理 UI 控件和事件回调"""
        try:
            if hasattr(self, 'logs') and self.logs:
                # 使用 del 显式删除控件，保留最后50条，减少内存占用
                if len(self.logs.controls) > 50:
                    # 删除除了最后50条之外的所有控件
                    del self.logs.controls[:-50]
                    self.logs.update()
            # 使用 print 而非 add_log，避免在清理时添加新的 UI 控件
            if self._debug_mode:
                print("[DEBUG] UI 控件已清理")
        except Exception as e:
            app_logger.exception("清理 UI 控件时出错")

    def clear_terminal(self):
        """
        清空终端内容

        功能说明：
        - 强制停止批处理
        - 清空日志控件
        - 清空队列中的所有待处理日志
        - 重置所有批处理状态
        - 使用 SnackBar 显示清空结果
        """
        import time

        # 1. 强制停止批处理
        if hasattr(self, '_processing'):
            self._processing = False
            if self._debug_mode:
                print("[DEBUG] 设置 _processing = False")

        # 2. 等待一小段时间确保没有正在运行的任务
        time.sleep(0.1)

        # 3. 清空日志控件
        control_count = len(self.logs.controls)
        self.logs.controls.clear()

        # 4. 清空队列中的所有待处理日志
        queue_size = self._log_queue.qsize()
        cleared_count = 0
        while not self._log_queue.empty():
            try:
                self._log_queue.get_nowait()
                cleared_count += 1
            except:
                break
        if cleared_count > 0 and self._debug_mode:
            print(f"[DEBUG] 清空了队列中的 {cleared_count}/{queue_size} 条日志")

        # 5. 重置所有批处理状态
        if hasattr(self, '_last_process_time'):
            self._last_process_time = time.time()

        if hasattr(self, '_schedule_retry_count'):
            self._schedule_retry_count = 0

        # 6. 更新UI
        try:
            self.logs.update()
        except Exception as ex:
            self.add_log(f"UI更新失败: {ex}")

        # 7. 重置 _processing 为 False，确保下次可以正常处理
        self._processing = False

        # 8. 使用 SnackBar 显示清空结果
        try:
            if self.view and self.view.page:
                from flet import SnackBar, Text
                total_cleared = control_count + cleared_count

                # 根据 DEBUG 模式决定显示详细程度
                if self._debug_mode:
                    message = f"✓ 已清空 {total_cleared} 条日志（界面: {control_count}, 队列: {cleared_count}）"
                else:
                    message = f"✓ 已清空 {total_cleared} 条日志"

                snack_bar = SnackBar(
                    Text(message),
                    duration=3000,
                )
                self.view.page.show_dialog(snack_bar)
        except Exception as ex:
            # 如果 SnackBar 显示失败，fallback 到普通日志
            self.add_log(f"✓ 终端已清空（界面: {control_count}, 队列: {cleared_count}）")

    def add_log(self, text: str):
        """线程安全的日志添加方法"""
        try:
            if not text:
                return

            # 检查是否为 DEBUG 日志
            is_debug = '[DEBUG]' in text or '[debug]' in text

            # 如果不是 DEBUG 模式且是 DEBUG 日志，则跳过显示（但仍然记录到文件）
            if is_debug and not self._debug_mode:
                if self.enable_logging:
                    processed_text = text[:self.LOG_MAX_LENGTH]
                    processed_text = re.sub(r'(\r?\n){3,}', '\n\n', processed_text.strip())
                    timestamp = datetime.datetime.now()
                    self._log_file_queue.put((timestamp, processed_text))
                return

            # 清理多余换行
            clean_text = re.sub(r'(\r?\n){3,}', '\n\n', text.strip())

            # 日志文件记录
            if self.enable_logging:
                self._rotate_log_file_if_needed()
                timestamp = datetime.datetime.now()
                self._log_file_queue.put((timestamp, clean_text))

            # 长度限制
            is_detailed_error = ('详细错误' in text or 'traceback' in text.lower() or
                                'Traceback' in text or 'File "' in text)
            max_length = self.LOG_MAX_LENGTH_DETAILED if is_detailed_error else self.LOG_MAX_LENGTH

            if len(clean_text) > max_length:
                processed_text = '...' + clean_text[-max_length:]
            else:
                processed_text = clean_text

            # ========== 队列积累保护：如果队列过大，触发紧急清理 ==========
            queue_size = self._log_queue.qsize()

            # 如果队列超过500条，保留最新100条（而非简单清空）
            if queue_size > 500:
                # 避免递归调用，直接处理
                preserved_entries = []
                discard_count = 0
                while not self._log_queue.empty():
                    try:
                        entry = self._log_queue.get_nowait()
                        if len(preserved_entries) < 100:
                            preserved_entries.append(entry)
                        else:
                            discard_count += 1
                    except:
                        break

                # 将保留的条目放回队列
                for entry in preserved_entries:
                    try:
                        self._log_queue.put_nowait(entry)
                    except:
                        pass

                queue_size = len(preserved_entries)
                if discard_count > 0 and self._debug_mode:
                    # 使用 print 避免递归调用 add_log
                    print(f"[WARNING] 队列积累过多，已丢弃 {discard_count} 条旧日志")
                    app_logger.warning(f"队列积累过多，已丢弃 {discard_count} 条旧日志")

            # 添加到队列（带条件变量通知）
            try:
                self._log_queue.put_nowait(processed_text)
                with self._log_queue_not_empty:
                    self._log_queue_not_empty.notify()  # 通知消费者
            except:
                # 队列已满，移除最旧的日志
                try:
                    self._log_queue.get_nowait()
                    self._log_queue.put_nowait(processed_text)
                    with self._log_queue_not_empty:
                        self._log_queue_not_empty.notify()
                except:
                    pass

            # ========== 每100条日志触发一次清理 ==========
            if not hasattr(self, '_log_count'):
                self._log_count = 0
            self._log_count += 1

            if self._log_count >= 100:
                self._log_count = 0
                # 在后台线程中执行清理，避免阻塞
                try:
                    cleanup_timer = self._create_timer(0.1, lambda: self.cleanup_all_resources(aggressive=False))
                    cleanup_timer.start()
                except:
                    pass

            # 立即安排处理少量日志
            current_time = time.time()

            if queue_size > 0 and (queue_size >= 3 or (current_time - self._last_process_time) >= 0.05):
                # 只在页面有效时才调度处理
                try:
                    if self.is_page_valid():
                        self._schedule_batch_process()
                except (RuntimeError, AttributeError):
                    # 页面无效，不处理
                    pass
            elif queue_size > 0:
                try:
                    if self.is_page_valid():
                        timer = self._create_timer(0.03, self._schedule_batch_process)
                        timer.start()
                except (RuntimeError, AttributeError):
                    # 页面无效，不处理
                    pass

        except (TypeError, IndexError, AttributeError) as e:
            app_logger.exception("日志处理异常")
        except Exception as e:
            app_logger.exception("日志处理未知错误")

    def set_page_ready(self, ready=True):
        """设置页面就绪标志"""
        self._page_ready = ready
        if ready:
            if not self._log_queue.empty():
                try:
                    self._schedule_batch_process()
                except Exception:
                    pass

    def _write_log_entries_to_file(self, entries):
        """将一批日志条目写入文件"""
        if not self.enable_logging:
            return

        try:
            with self._log_file_lock:
                if self._log_file_handle is None:
                    return

                log_lines = []
                for timestamp, text in entries:
                    formatted_timestamp = timestamp.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                    clean_text = re.sub(r'\x1b\[[0-9;]*m', '', text)
                    log_lines.append(f"[{formatted_timestamp}] {clean_text}\n")

                try:
                    self._log_file_handle.writelines(log_lines)
                    self._log_file_handle.flush()
                except OSError as e:
                    app_logger.error(f"写入日志文件时发生IO错误: {str(e)}")
                    try:
                        self._log_file_handle.close()
                        # 检查重新打开是否成功
                        if self._open_log_file() and self._log_file_handle is not None:
                            self._log_file_handle.writelines(log_lines)
                            self._log_file_handle.flush()
                        else:
                            app_logger.error("无法重新打开日志文件，跳过本次写入")
                    except Exception as retry_error:
                        app_logger.error(f"重试写入日志文件也失败: {str(retry_error)}")

        except Exception as e:
            app_logger.exception("写入日志文件失败")

    def _flush_log_buffer(self):
        """刷新日志缓冲区"""
        timeout = time.time() + 5
        while not self._log_file_queue.empty() and time.time() < timeout:
            time.sleep(0.01)

        with self._log_file_lock:
            if self._log_file_handle:
                try:
                    self._log_file_handle.flush()
                except:
                    pass