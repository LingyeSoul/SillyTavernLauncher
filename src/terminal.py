import flet as ft
import datetime
import re
import threading
import queue
import time
import os


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
    MAX_LOG_ENTRIES = 1500  # 增加UI控件数量限制
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
            #build_controls_on_demand=True,
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
                    print(f"日志处理循环错误: {str(e)}")

        # 在单独的线程中运行日志处理循环
        self._log_thread = threading.Thread(target=log_processing_worker, daemon=True)
        self._log_thread.start()

    # ============ 日志文件写入线程 ============

    def _start_log_file_thread(self):
        """启动日志文件写入线程"""
        def log_file_worker():
            """日志文件写入工作线程"""
            # 预先打开文件句柄
            self._open_log_file()

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
                        self._write_log_entries_to_file(entries)

                except Exception as e:
                    print(f"日志文件写入线程错误: {str(e)}")

            # 关闭文件句柄
            self._close_log_file()

        # 启动日志文件写入线程
        self._log_file_thread = threading.Thread(target=log_file_worker, daemon=True)
        self._log_file_thread.start()

    # ============ 日志文件操作 ============

    def _open_log_file(self):
        """打开日志文件句柄"""
        if not self.enable_logging:
            return

        try:
            logs_dir = os.path.join(os.getcwd(), "logs")
            os.makedirs(logs_dir, exist_ok=True)
            log_file_path = os.path.join(logs_dir, f"{self.launch_timestamp}.log")

            with self._log_file_lock:
                if self._log_file_handle is None:
                    self._log_file_handle = open(log_file_path, "a", encoding="utf-8", buffering=8192)
        except Exception as e:
            print(f"打开日志文件失败: {str(e)}")

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
            self._open_log_file()
            self.add_log(f"[INFO] 日志文件轮转到新文件: {self.launch_timestamp}.log")

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
                self.logs.controls = self.logs.controls[-self._max_log_entries//2:]

            self._last_process_time = current_time

            # 批量更新UI
            try:
                if hasattr(self, 'view') and self.view is not None:
                    page = self.view.page  # 可能抛出 RuntimeError
                    if page is not None:
                        self.logs.update()
            except (AssertionError, RuntimeError, AttributeError):
                # 控件树问题或控件已从页面移除，忽略
                pass

        except Exception as e:
            import traceback
            print(f"批量处理失败: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")
        finally:
            self._processing = False
            if not self._log_queue.empty():
                self._schedule_batch_process()

    def _schedule_batch_process(self):
        """安排批量处理"""
        # 检查 view 是否存在且仍在页面上
        try:
            if hasattr(self, 'view') and self.view is not None:
                page = self.view.page  # 可能抛出 RuntimeError
                if page is not None:
                    try:
                        async def async_process_batch():
                            self._process_batch()

                        page.run_task(async_process_batch)
                        return
                    except (AssertionError, RuntimeError) as e:
                        if "Event loop is closed" in str(e):
                            # 事件循环已关闭，直接处理
                            try:
                                self._process_batch()
                            except Exception:
                                pass
                            return
        except (RuntimeError, AttributeError):
            # 控件已从页面移除或 page 属性访问失败
            pass

        # 如果异步调度失败，尝试同步处理
        try:
            self._process_batch()
        except Exception:
            pass

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
            self.logs.controls = self.logs.controls[-100:]
            if self._debug_mode:
                self.add_log(f"[DEBUG] 清理了 {old_count - 100} 个日志控件")

            # 强制更新UI
            try:
                if hasattr(self, 'view') and self.view is not None:
                    page = self.view.page  # 可能抛出 RuntimeError
                    if page is not None:
                        self.logs.update()
            except (RuntimeError, AttributeError):
                pass  # 控件已从页面移除，忽略更新

    def stop_processes(self):
        """停止所有进程（多阶段终止策略）"""
        # ========== 新增：使用锁获取进程列表 ==========
        with self._active_processes_lock:
            if not self.active_processes:
                return False
            processes_to_stop = self.active_processes[:]  # 创建副本
            self.active_processes = []  # 立即清空原列表

        self.add_log(f"正在终止 {len(processes_to_stop)} 个进程...")

        # 刷新日志缓冲区
        self._flush_log_buffer()

        # 设置停止事件
        self._stop_event.set()
        self._log_file_stop_event.set()

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
                    time.sleep(0.1)
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
                        time.sleep(0.1)
                        if hasattr(process, 'poll') and process.poll() is not None:
                            break
                        elif hasattr(process, 'returncode') and process.returncode is not None:
                            break

            except Exception as ex:
                error_msg = str(ex).strip()
                if error_msg:
                    self.add_log(f"终止进程 {proc_info['pid']} 时出错: {error_msg}")

        # 保存需要验证的进程列表
        processes_to_verify = self.active_processes[:]
        self.active_processes = []

        self.add_log("所有进程已终止")

        # 阶段 3: 使用 taskkill 清理残留进程
        self.add_log("检查并清理残留进程...")
        killed_count = 0

        for proc_info in processes_to_verify:
            pid = proc_info['pid']
            if self._verify_process_running(pid):
                self.add_log(f"  发现残留进程 PID={pid}，正在清理...")
                if self._kill_process_by_pid(pid, use_tree=False):
                    self.add_log(f"  ✓ 成功清理 PID={pid}")
                    killed_count += 1
                else:
                    self.add_log(f"  ⚠ 清理失败 PID={pid}")

        if killed_count > 0:
            self.add_log(f"✓ 成功清理 {killed_count} 个残留进程")
        else:
            self.add_log("✓ 所有进程已成功终止")

        # ========== 新增：执行全面资源清理 ==========
        try:
            cleanup_stats = self.cleanup_all_resources(aggressive=True)
            self.add_log(
                f"[清理] 任务={cleanup_stats['tasks_cleaned']}, "
                f"额外进程={cleanup_stats['processes_cleaned']}, "
                f"线程={cleanup_stats['threads_cleaned']}"
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
        """
        import asyncio

        # 使用局部引用
        terminal = self

        # 记录流类型（用于调试）
        stream_type = "STDERR" if is_stderr else "STDOUT"
        if terminal._debug_mode:
            terminal.add_log(f"[DEBUG] 开始读取 {stream_type} 流")

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
                            terminal.add_log(decoded_line)
                    except Exception as decode_error:
                        if terminal._debug_mode:
                            terminal.add_log(f"[DEBUG] 解码错误: {decode_error}")

                except asyncio.TimeoutError:
                    # 超时不是错误，继续等待
                    if stream.at_eof():
                        break
                    continue

        except asyncio.CancelledError:
            # 任务被取消，正常退出
            if terminal._debug_mode:
                terminal.add_log(f"[DEBUG] 输出读取任务被取消")

        except Exception as ex:
            # 记录错误但不中断
            try:
                if hasattr(terminal, 'view') and terminal.view is not None:
                    page = terminal.view.page  # 可能抛出 RuntimeError
                    if page is not None:
                        terminal.add_log(f"输出处理错误: {type(ex).__name__}: {str(ex)}")
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

                    # 移除进程引用
                    removed = term_ref.remove_process(proc_ref.pid)
                    if term_ref._debug_mode and removed:
                        term_ref.add_log(f"[DEBUG] 已移除进程 PID={proc_ref.pid}")
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

        # 6. 启动周期性清理定时器（如果尚未启动）
        if not hasattr(self, '_cleanup_timer_started'):
            self._start_periodic_cleanup()

        self.add_log(
            f"[CLEANUP] 清理完成: "
            f"任务={stats['tasks_cleaned']}, "
            f"进程={stats['processes_cleaned']}, "
            f"线程={stats['threads_cleaned']}, "
            f"队列={stats['queues_cleared']}, "
            f"内存={stats['memory_freed']:.1f}MB"
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

        if hasattr(self, '_cleanup_timer') and self._cleanup_timer:
            return  # 已经启动

        self._cleanup_timer_started = True

        def periodic_cleanup():
            """每60秒执行一次清理"""
            while hasattr(self, '_cleanup_timer_started') and self._cleanup_timer_started:
                try:
                    time.sleep(60)  # 60秒间隔
                    if hasattr(self, '_cleanup_timer_started') and self._cleanup_timer_started:
                        self.add_log("[PERIODIC] 执行周期性清理...")
                        self.cleanup_all_resources(aggressive=False)
                except Exception as e:
                    self.add_log(f"[ERROR] 周期性清理失败: {str(e)}")

        # 启动后台清理线程
        cleanup_thread = threading.Thread(target=periodic_cleanup, daemon=True)
        cleanup_thread.start()
        self.add_log("[CLEANUP] 周期性清理定时器已启动 (间隔: 60秒)")

    def stop_periodic_cleanup(self):
        """停止周期性清理定时器"""
        if hasattr(self, '_cleanup_timer_started'):
            self._cleanup_timer_started = False
            # 不在关闭时输出日志，避免 "can't create new thread at interpreter shutdown" 错误
            # self.add_log("[CLEANUP] 周期性清理定时器已停止")

    def __del__(self):
        """
        析构函数 - 确保对象销毁时清理所有资源

        注意：Python 不保证 __del__ 一定会被调用，所以不应依赖它进行关键清理
        """
        try:
            # 停止周期性清理
            if hasattr(self, '_cleanup_timer_started'):
                self._cleanup_timer_started = False

            # 执行最后一次激进清理
            if hasattr(self, 'cleanup_all_resources'):
                self.cleanup_all_resources(aggressive=True)
        except Exception:
            # 析构函数中不应该抛出异常
            pass

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
        if self.page is None:
            return False
        if hasattr(self.page, 'window') and self.page.window is None:
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

            # 如果队列超过500条，立即清理队列
            if queue_size > 500:
                self.add_log(f"[WARNING] 队列积累过多 ({queue_size} 条)，触发紧急清理")
                # 清空队列
                while not self._log_queue.empty():
                    try:
                        self._log_queue.get_nowait()
                    except:
                        break
                queue_size = 0

            # 添加到队列
            try:
                self._log_queue.put_nowait(processed_text)
            except:
                # 队列已满，放弃最旧的日志
                try:
                    self._log_queue.get_nowait()
                    self._log_queue.put_nowait(processed_text)
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
                    cleanup_timer = threading.Timer(0.1, lambda: self.cleanup_all_resources(aggressive=False))
                    cleanup_timer.daemon = True
                    cleanup_timer.start()
                except:
                    pass

            # 立即安排处理少量日志
            current_time = time.time()

            if queue_size > 0 and (queue_size >= 3 or (current_time - self._last_process_time) >= 0.05):
                self._schedule_batch_process()
            elif queue_size > 0:
                try:
                    if hasattr(self, 'view') and self.view is not None:
                        page = self.view.page  # 可能抛出 RuntimeError
                        if page is not None:
                            timer = threading.Timer(0.03, self._schedule_batch_process)
                            timer.start()
                    else:
                        self._schedule_batch_process()
                except (RuntimeError, AttributeError):
                    self._schedule_batch_process()

        except (TypeError, IndexError, AttributeError) as e:
            import traceback
            print(f"日志处理异常: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")
        except Exception as e:
            import traceback
            print(f"未知错误: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")

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
                    print(f"写入日志文件时发生IO错误: {str(e)}")
                    try:
                        self._log_file_handle.close()
                        self._open_log_file()
                        self._log_file_handle.writelines(log_lines)
                        self._log_file_handle.flush()
                    except Exception as retry_error:
                        print(f"重试写入日志文件也失败: {str(retry_error)}")

        except Exception as e:
            print(f"写入日志文件失败: {str(e)}")

    def _write_log_to_file(self, text: str):
        """将日志写入文件（已废弃，保留向后兼容性）"""
        if self.enable_logging:
            timestamp = datetime.datetime.now()
            try:
                self._log_file_queue.put_nowait((timestamp, text))
            except queue.Full:
                pass

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