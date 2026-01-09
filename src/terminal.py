import flet as ft
import datetime
import re
import threading
import queue
import time
import os
import asyncio


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
    MAX_QUEUE_SIZE = 10000  # 增加队列最大条目数（从1000提升到10000）
    MAX_LOG_ENTRIES = 1500  # 增加UI控件数量限制（从200提升到1500）
    LOG_MAX_LENGTH = 1000  # 单条日志长度限制
    LOG_MAX_LENGTH_DETAILED = 5000  # 详细日志（如traceback）的长度限制
    BATCH_SIZE_THRESHOLD = 30  # 增加批量处理阈值（从50提升到30，更频繁处理）
    PROCESS_INTERVAL = 0.02  # 处理间隔优化为20ms（从50ms降低）

    # ⚡ 新增：日志显示和记录分离
    MAX_DISPLAY_LOGS = 150  # 终端最多显示150条（保持不变）
    HIGH_LOAD_THRESHOLD = 500  # 提高高负载阈值（从200提升到500）
    OVERLOAD_THRESHOLD = 2000  # 提高过载阈值（从500提升到2000）
    
    # 日志文件大小限制（100MB）
    MAX_LOG_FILE_SIZE = 100 * 1024 * 1024

    def __init__(self, page, enable_logging=True, local_enabled=False):
        self.logs = ft.ListView(
            expand=True,
            spacing=5,
            auto_scroll=True,  # 启用自动滚动
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
        self.is_running = False  # 添加运行状态标志
        self.enable_logging = enable_logging

        # DEBUG 模式控制
        self._debug_mode = False  # 是否启用 DEBUG 模式（显示所有 DEBUG 信息）

        # ============ 异步原语（延迟初始化）============
        self._log_queue = None  # asyncio.Queue，稍后在异步上下文中初始化
        self._stop_event = None  # asyncio.Event
        self._processing_lock = None  # asyncio.Lock
        self._background_check_stop_event = None  # asyncio.Event
        self._process_monitor_stop_event = None  # asyncio.Event
        self._ui_processing_lock = None  # asyncio.Lock
        self._async_initialized = False  # 标记异步是否已初始化
        self._async_tasks = []  # 存储异步任务引用
        self._page = page  # 保存page引用用于异步初始化

        # ============ 保留的线程相关变量（文件I/O）============
        # 日志文件写入线程相关属性
        self._log_file_queue = queue.Queue(maxsize=10000)  # 有界队列
        self._log_file_thread = None
        self._log_file_stop_event = threading.Event()
        self._log_file_handle = None  # 文件句柄，保持打开以减少I/O
        self._log_file_lock = threading.Lock()

        # ============ 性能优化常量 ============
        self._last_process_time = time.time()  # 初始化为当前时间
        self._process_interval = 0.02  # 20ms
        self._processing = False  # 阻止并发处理的标志
        self._batch_size_threshold = 30
        self._max_log_entries = 1500

        # UI更新防抖（避免频繁更新）
        self._update_pending = False
        self._update_lock = threading.Lock()  # 保留，用于UI更新同步
        self._update_timer = None  # 存储Timer对象以便取消
        self._last_ui_update = time.time()
        self._is_shutting_down = False  # 关闭标志
        self._ui_update_fail_count = 0
        self._page_ready = False  # 页面就绪标志

        # 记录上次UI刷新时间，用于避免重复刷新
        self._last_refresh_time = 0
        self._refresh_cooldown = 0.05  # 50ms 刷新冷却时间

        # ============ 调度异步初始化 ============
        self._schedule_async_init()

        # 启动日志文件写入线程（保留线程）
        if self.enable_logging:
            self._start_log_file_thread()

    # ============ 异步初始化方法 ============

    def _schedule_async_init(self):
        """调度异步初始化"""
        try:
            self._page.run_task(self._async_initialize)
        except Exception as e:
            print(f"Failed to schedule async init: {e}")

    async def _async_initialize(self):
        """在事件循环中初始化异步原语"""
        if self._async_initialized:
            return

        try:
            # 初始化异步原语
            self._log_queue = asyncio.Queue(maxsize=10000)
            self._stop_event = asyncio.Event()
            self._processing_lock = asyncio.Lock()
            self._background_check_stop_event = asyncio.Event()
            self._process_monitor_stop_event = asyncio.Event()
            self._ui_processing_lock = asyncio.Lock()

            # 启动异步工作器
            self._start_async_workers()

            self._async_initialized = True
            print("AsyncTerminal async initialization complete")
        except Exception as e:
            print(f"Async initialization failed: {e}")
            import traceback
            traceback.print_exc()

    def _start_async_workers(self):
        """启动所有异步工作器"""
        # 日志处理工作器
        task1 = asyncio.create_task(self._log_processing_worker())
        # 后台检查工作器
        task2 = asyncio.create_task(self._background_check_worker())
        # 进程监控工作器
        task3 = asyncio.create_task(self._process_monitor_worker())

        self._async_tasks.extend([task1, task2, task3])

    # ============ 异步工作器 ============

    async def _log_processing_worker(self):
        """主日志处理工作器（替换 _log_thread）"""
        while not self._stop_event.is_set():
            try:
                # 检查队列是否有项目
                if not self._log_queue.empty():
                    await self._schedule_batch_process_async()
                    # 高负载时立即继续处理，不要等待
                    continue

                # 队列空时才小睡（减少延迟）
                await asyncio.sleep(0.001)  # 1ms（从20ms优化到1ms）
            except Exception as e:
                print(f"Log processing worker error: {e}")

    async def _background_check_worker(self):
        """后台检查工作器（替换 _background_check_thread）"""
        while not self._background_check_stop_event.is_set():
            try:
                current_time = time.time()

                # 如果超过1秒没有更新UI，且队列为空，尝试刷新
                if (current_time - self._last_ui_update > 1.0 and
                    self._log_queue.empty() and
                    current_time - self._last_refresh_time > self._refresh_cooldown):

                    async with self._ui_processing_lock:
                        if self._page_ready and self._is_page_available():
                            try:
                                await self._update_ui_async()
                                self._last_ui_update = current_time
                                self._last_refresh_time = current_time
                            except Exception:
                                pass

                await asyncio.sleep(0.1)  # 100ms
            except Exception as e:
                print(f"Background check worker error: {e}")

    async def _process_monitor_worker(self):
        """进程监控工作器（替换 _process_monitor_thread）"""
        # 记录已报告退出的进程，避免重复日志
        reported_exited_pids = {}

        while not self._process_monitor_stop_event.is_set():
            try:
                if self.is_running and self.active_processes:
                    all_stopped = True
                    current_time = time.time()

                    # 清理超过1小时的已退出进程记录
                    expired_pids = [pid for pid, report_time in reported_exited_pids.items()
                                   if current_time - report_time > 3600]
                    for pid in expired_pids:
                        del reported_exited_pids[pid]

                    for proc_info in self.active_processes:
                        process = proc_info.get('process')
                        pid = proc_info.get('pid')

                        # 检查进程是否仍在运行
                        is_running = False
                        if hasattr(process, 'poll'):  # subprocess.Popen
                            is_running = process.poll() is None
                        elif hasattr(process, 'returncode'):  # asyncio.subprocess.Process
                            is_running = process.returncode is None

                        if is_running:
                            all_stopped = False
                            # 如果进程还在运行，从已退出集合中移除
                            reported_exited_pids.pop(pid, None)
                        else:
                            # 进程已退出，只记录一次日志（并在1小时内不再重复记录）
                            if pid not in reported_exited_pids:
                                self.add_log(f"[DEBUG] 进程 PID={pid} 已退出")
                                reported_exited_pids[pid] = current_time  # 记录退出时间

                    # 如果所有进程都已停止，更新状态并清空记录
                    if all_stopped:
                        if self.is_running:
                            self.add_log("检测到所有进程已停止")
                            self.is_running = False
                            reported_exited_pids.clear()

                await asyncio.sleep(1.0)  # 每秒检查一次
            except Exception as e:
                print(f"Process monitor worker error: {e}")

    # ============ 日志文件写入线程（保留）============

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
                    self._log_file_handle = open(log_file_path, "a", encoding="utf-8", buffering=8192)  # 8KB缓冲区
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
                # 如果无法获取当前位置，尝试获取文件大小
                try:
                    log_file_path = os.path.join(os.getcwd(), "logs", f"{self.launch_timestamp}.log")
                    return os.path.getsize(log_file_path) if os.path.exists(log_file_path) else 0
                except:
                    return 0
        return 0

    def _rotate_log_file_if_needed(self):
        """检查是否需要轮转日志文件"""
        if self._get_current_log_file_size() >= self.MAX_LOG_FILE_SIZE:
            # 关闭当前文件
            self._close_log_file()
            # 创建新时间戳
            self.launch_timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            # 打开新文件
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

            # tasklist 返回 0 表示找到进程
            # 检查输出中是否包含 PID
            is_running = str(pid) in result.stdout and result.returncode == 0
            self.add_log(f"[DEBUG] PID={pid} 是否运行: {is_running}")
            return is_running
        except Exception as e:
            self.add_log(f"[DEBUG] 验证 PID={pid} 时出错: {str(e)}")
            return False

    def _get_all_node_processes(self):
        """获取所有 node.exe 进程的 PID 列表"""
        import subprocess
        try:
            result = subprocess.run(
                ['tasklist', '/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV'],
                capture_output=True,
                text=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
                encoding='gbk',
                errors='ignore'
            )

            if result.returncode != 0:
                return []

            # 解析 CSV 输出，提取 PID
            pids = []
            lines = result.stdout.strip().split('\n')
            for line in lines[1:]:  # 跳过标题行
                if 'node.exe' in line:
                    parts = line.split(',')
                    if len(parts) >= 2:
                        try:
                            pid = int(parts[1].strip('"'))
                            pids.append(pid)
                        except ValueError:
                            pass

            return pids
        except Exception:
            return []

    def _kill_process_by_pid(self, pid, use_tree=True):
        """使用 taskkill 强制杀死指定 PID 的进程（微软官方工具，更安全）

        Args:
            pid: 进程 ID
            use_tree: 是否使用 /T 参数终止进程树（包括子进程）
        """
        import subprocess
        try:
            cmd = ['taskkill', '/F', '/PID', str(pid)]
            if use_tree:
                cmd.append('/T')  # 终止进程树

            result = subprocess.run(
                cmd,
                capture_output=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
                text=True,
                encoding='gbk',
                errors='ignore'
            )

            # taskkill 返回 0 表示成功，返回 1 表示进程不存在
            return result.returncode in [0, 1]
        except Exception:
            return False

    # ============ 异步工作器停止 ============

    def _stop_async_workers(self):
        """停止所有异步工作器"""
        if not self._async_initialized:
            return

        # 设置停止事件
        if self._stop_event:
            self._stop_event.set()
        if self._background_check_stop_event:
            self._background_check_stop_event.set()
        if self._process_monitor_stop_event:
            self._process_monitor_stop_event.set()

        # 取消任务
        for task in self._async_tasks:
            if not task.done():
                task.cancel()

        self._async_tasks.clear()
        self._async_initialized = False

    # ============ 进程管理 ============

    def stop_processes(self):
        """停止所有由execute_command启动的进程

        使用多阶段终止策略：
        1. 优雅终止（SIGTERM）
        2. 强制终止（SIGKILL）
        3. taskkill /F 终止残留进程
        """
        # 检查是否有活跃的进程
        if not self.active_processes:
            return False  # 没有进程需要停止

        self.add_log("正在终止所有进程...")

        # 刷新日志缓冲区
        self._flush_log_buffer()

        # 停止异步工作器
        self._stop_async_workers()

        # 设置停止事件（仅日志文件线程）
        self._log_file_stop_event.set()

        # 停止所有异步任务（来自execute_command的输出读取任务）
        if hasattr(self, '_output_tasks'):
            for task in self._output_tasks:
                if not task.done():
                    task.cancel()
            self._output_tasks = []

        import signal

        # 阶段 1 & 2: 优雅终止 + 强制终止
        for proc_info in self.active_processes[:]:
            try:
                pid = proc_info['pid']
                process = proc_info.get('process')
                command = proc_info.get('command', '')

                self.add_log(f"终止进程 PID={pid}: {command[:50]}")

                # 检查进程是否仍在运行
                is_running = False
                if hasattr(process, 'poll'):  # subprocess.Popen
                    is_running = process.poll() is None
                elif hasattr(process, 'returncode'):  # asyncio.subprocess.Process
                    is_running = process.returncode is None

                if not is_running:
                    self.add_log(f"  进程 PID={pid} 已停止")
                    continue

                # 阶段 1: 优雅终止（SIGTERM）
                try:
                    if hasattr(process, 'terminate'):  # subprocess.Popen
                        process.terminate()
                    elif hasattr(process, 'send_signal'):  # asyncio.subprocess.Process
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
            # 使用 tasklist 验证进程是否仍在运行
            if self._verify_process_running(pid):
                self.add_log(f"  发现残留进程 PID={pid}，正在清理...")
                if self._kill_process_by_pid(pid, use_tree=False):  # 不需要 /T，因为没有进程组
                    self.add_log(f"  ✓ 成功清理 PID={pid}")
                    killed_count += 1
                else:
                    self.add_log(f"  ⚠ 清理失败 PID={pid}")

        if killed_count > 0:
            self.add_log(f"✓ 成功清理 {killed_count} 个残留进程")
        else:
            self.add_log("✓ 所有进程已成功终止")

        # 标记为不再运行
        self.is_running = False

        # 重置停止事件，允许后续日志处理
        self._stop_event.clear()

        return True

    # ============ 异步批处理和UI更新 ============

    async def _schedule_batch_process_async(self):
        """异步批处理"""
        if self._processing:
            return

        async with self._processing_lock:
            try:
                # 循环处理直到队列为空（防止递归调用因锁而失败）
                batch_count = 0
                while True:
                    queue_size = self._log_queue.qsize()
                    if queue_size == 0:
                        break

                    # 自适应批量大小（针对高负载优化）
                    if queue_size > 1000:
                        batch_limit = 500  # 极高负载：500条/批
                    elif queue_size > 500:
                        batch_limit = 300  # 高负载：300条/批
                    elif queue_size > 200:
                        batch_limit = 200  # 中高负载：200条/批
                    elif queue_size > 50:
                        batch_limit = 100  # 中等负载：100条/批
                    else:
                        batch_limit = 50  # 低负载：50条/批

                    batch_limit = min(batch_limit, queue_size)

                    # 收集日志条目
                    log_entries = []
                    for _ in range(batch_limit):
                        try:
                            entry = self._log_queue.get_nowait()
                            log_entries.append(entry)
                        except asyncio.QueueEmpty:
                            break

                    if not log_entries:
                        break

                    # 创建UI控件
                    new_controls = []
                    for processed_text in log_entries:
                        if ANSI_ESCAPE_REGEX.search(processed_text):
                            spans = parse_ansi_text(processed_text)
                            new_text = ft.Text(spans=spans, selectable=True, size=14)
                        else:
                            new_text = ft.Text(processed_text, selectable=True, size=14)
                        new_controls.append(new_text)

                    # 更新UI
                    async with self._ui_processing_lock:
                        self.logs.controls.extend(new_controls)
                        while len(self.logs.controls) > self.MAX_LOG_ENTRIES:
                            del self.logs.controls[0]
                        self._last_process_time = time.time()

                        # 调度UI更新（高负载时降低刷新限制）
                        current_time = time.time()
                        # 高负载时（队列>500）降低冷却时间到5ms，否则使用正常冷却时间
                        cooldown = 0.005 if queue_size > 500 else self._refresh_cooldown
                        if current_time - self._last_refresh_time > cooldown:
                            if self._page_ready:
                                await self._update_ui_async()
                                self._last_ui_update = current_time
                                self._last_refresh_time = current_time

                    # 每处理5个批次后短暂yield，避免阻塞其他协程
                    batch_count += 1
                    if batch_count % 5 == 0:
                        await asyncio.sleep(0)

                    # 继续循环处理剩余日志

            except Exception as e:
                print(f"Batch processing error: {e}")
            finally:
                self._processing = False

    async def _update_ui_async(self):
        """异步UI更新"""
        if self._is_page_available():
            try:
                # 使用同步回调进行UI更新
                self.logs.update()
            except Exception:
                pass

    def _is_page_available(self):
        """检查页面是否可用"""
        try:
            return (hasattr(self, 'view') and
                    self.view is not None and
                    hasattr(self.view, 'page') and
                    self.view.page is not None and
                    not getattr(self.view.page, 'closed', False))
        except Exception:
            return False

    # ============ 公共API方法 ============

    def enable_debug_mode(self, enabled=True):
        """
        启用或禁用 DEBUG 模式

        Args:
            enabled (bool): True 启用 DEBUG 模式，False 禁用
        """
        self._debug_mode = enabled
        if enabled:
            self.add_log("[DEBUG] DEBUG 模式已启用 - 将显示所有调试信息")
        else:
            self.add_log("[DEBUG] DEBUG 模式已禁用 - 将隐藏调试信息")

    # ============ 桥接机制 ============

    def _enqueue_log_async(self, processed_text: str):
        """桥接同步到异步"""
        # 如果异步未初始化，直接同步处理
        if not self._async_initialized:
            self._process_log_sync(processed_text)
            return

        # 异步已初始化，尝试放入队列
        # 使用 try/except 避免队列满时阻塞
        try:
            self._log_queue.put_nowait(processed_text)
        except asyncio.QueueFull:
            # 队列满时，同步处理
            self._process_log_sync(processed_text)

    async def _put_log_async(self, text: str):
        """异步放入队列"""
        try:
            if self._log_queue and not self._log_queue.full():
                await self._log_queue.put(text)
        except Exception as e:
            print(f"Failed to put log in queue: {e}")

    def _process_log_sync(self, text: str):
        """同步日志处理回退"""
        # 直接UI更新
        if ANSI_ESCAPE_REGEX.search(text):
            spans = parse_ansi_text(text)
            new_text = ft.Text(spans=spans, selectable=True, size=14)
        else:
            new_text = ft.Text(text, selectable=True, size=14)

        try:
            self.logs.controls.append(new_text)
            while len(self.logs.controls) > self.MAX_LOG_ENTRIES:
                del self.logs.controls[0]
            if self._page_ready and self._is_page_available():
                self.logs.update()
        except Exception:
            pass

    # ============ 公共API方法 ============

    def add_log(self, text: str):
        """线程安全的日志添加方法（桥接到异步）"""
        try:
            # 优先处理空值情况
            if not text:
                return

            # 检查是否为 DEBUG 日志
            is_debug = '[DEBUG]' in text or '[debug]' in text

            # 如果不是 DEBUG 模式且是 DEBUG 日志，则跳过显示（但仍然记录到文件）
            if is_debug and not self._debug_mode:
                # 只记录到文件，不显示在终端
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
                # 检查是否需要轮转日志文件
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

            # 桥接：异步上下文检测和调度
            self._enqueue_log_async(processed_text)

        except (TypeError, IndexError, AttributeError) as e:
            import traceback
            print(f"日志处理异常: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")
        except Exception as e:
            import traceback
            print(f"未知错误: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")

    def _clear_logs_async(self):
        """异步清空日志"""
        def clear_logs():
            try:
                self.logs.controls.clear()
                if hasattr(self, 'view') and self.view.page is not None:
                    self.logs.update()
            except Exception as e:
                print(f"清空日志失败: {str(e)}")

        if hasattr(self, 'view') and self.view.page is not None:
            try:
                async def async_clear_logs():
                    clear_logs()
                self.view.page.run_task(async_clear_logs)
            except (RuntimeError, Exception):
                clear_logs()

        # 清空异步队列（asyncio.Queue 没有简单的 clear 方法）
        if self._async_initialized and self._log_queue:
            async def clear_queue():
                while not self._log_queue.empty():
                    try:
                        self._log_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
            try:
                self._page.run_task(clear_queue)
            except Exception:
                pass  # 如果清空失败，忽略

    def set_page_ready(self, ready=True):
        """
        设置页面就绪标志

        当控件被添加到页面后，应该调用此方法标记页面就绪，
        这样日志处理线程才能安全地更新 UI。

        Args:
            ready (bool): True 表示页面已就绪，False 表示页面未就绪
        """
        self._page_ready = ready
        if ready:
            # 页面就绪后，立即处理队列中的日志（如果异步初始化已完成）
            if self._async_initialized and self._log_queue and not self._log_queue.empty():
                # 调度异步批处理
                try:
                    self._page.run_task(self._schedule_batch_process_async)
                except Exception:
                    pass  # 如果调度失败，忽略

    def _write_log_entries_to_file(self, entries):
        """将一批日志条目写入文件（优化版 - 使用保持打开的文件句柄）"""
        if not self.enable_logging:
            return

        try:
            with self._log_file_lock:
                if self._log_file_handle is None:
                    return

                # 准备日志内容
                log_lines = []
                for timestamp, text in entries:
                    formatted_timestamp = timestamp.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]  # 包含毫秒
                    clean_text = re.sub(r'\x1b\[[0-9;]*m', '', text)
                    log_lines.append(f"[{formatted_timestamp}] {clean_text}\n")

                # 批量写入并flush
                try:
                    self._log_file_handle.writelines(log_lines)
                    self._log_file_handle.flush()  # 确保写入磁盘
                except OSError as e:
                    print(f"写入日志文件时发生IO错误: {str(e)}")
                    # 尝试重新打开文件
                    try:
                        self._log_file_handle.close()
                        self._open_log_file()
                        # 重试写入
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
                pass  # 队列满时丢弃

    def _flush_log_buffer(self):
        """刷新日志缓冲区，确保所有日志都被写入文件（优化版）"""
        # 等待日志文件队列处理完毕（最多5秒）
        timeout = time.time() + 5
        while not self._log_file_queue.empty() and time.time() < timeout:
            time.sleep(0.01)

        # 强制flush文件
        with self._log_file_lock:
            if self._log_file_handle:
                try:
                    self._log_file_handle.flush()
                except:
                    pass