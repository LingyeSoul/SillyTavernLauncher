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
    MAX_QUEUE_SIZE = 1000  # 队列最大条目数（背压机制）
    MAX_LOG_ENTRIES = 500  # 减少UI控件数量（从1500降到500）
    LOG_MAX_LENGTH = 1000  # 单条日志长度限制（从2000降到1000）
    BATCH_SIZE_THRESHOLD = 50  # 批量处理阈值（从30增加到50）
    PROCESS_INTERVAL = 0.05  # 处理间隔50ms（从20ms增加到50ms）

    def __init__(self, page, enable_logging=True, local_enabled=False):
        self.logs = ft.ListView(
            expand=True,
            spacing=5,
            auto_scroll=True,  # 恢复自动滚动
            padding=10
        )
        # 初始化启动时间戳
        self.launch_timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

        # 读取配置以确定是否启用局域网访问
        if page.platform == ft.PagePlatform.WINDOWS:
            # 只在启用局域网访问时获取并显示IP
            from network import get_local_ip
            if local_enabled:
                local_ip = get_local_ip()
                title_text = f"局域网IP：{local_ip}"
            else:
                title_text = ""
            self.view = ft.Column([
                ft.Row([
                        ft.Text("终端", size=24, weight=ft.FontWeight.BOLD),
                        ft.Text(title_text, size=16, color=ft.Colors.BLUE_300),
                        ], alignment=ft.CrossAxisAlignment.CENTER),

                ft.Container(
                    content=self.logs,
                    border=ft.border.all(1, ft.Colors.GREY_400),
                    padding=10,
                    width=730,
                    height=440,
                )
            ])

        self.active_processes = []
        self.is_running = False  # 添加运行状态标志
        self._output_threads = []  # 存储输出处理线程
        self.enable_logging = enable_logging

        # 异步处理相关属性 - 使用有界队列防止内存溢出
        self._log_queue = queue.Queue(maxsize=self.MAX_QUEUE_SIZE)
        self._last_process_time = 0  # 上次处理时间
        self._process_interval = self.PROCESS_INTERVAL  # 优化为50ms
        self._processing = False  # 阻止并发处理
        self._batch_size_threshold = self.BATCH_SIZE_THRESHOLD  # 优化为50
        self._stop_event = threading.Event()  # 停止事件
        self._max_log_entries = self.MAX_LOG_ENTRIES  # 优化为500

        # 日志文件写入线程相关属性
        self._log_file_queue = queue.Queue(maxsize=self.MAX_QUEUE_SIZE)
        self._log_file_thread = None
        self._log_file_stop_event = threading.Event()
        self._log_file_handle = None  # 文件句柄，保持打开以减少I/O
        self._log_file_lock = threading.Lock()

        # UI更新防抖（避免频繁更新）
        self._update_pending = False
        self._update_lock = threading.Lock()
        self._update_timer = None  # 存储Timer对象以便取消
        self._last_ui_update = 0  # 记录上次UI更新时间

        # 启动异步日志处理循环
        self._start_log_processing_loop()
        # 启动日志文件写入线程
        self._start_log_file_thread()

    def _start_log_processing_loop(self):
        """启动异步日志处理循环"""
        def log_processing_worker():
            while not self._stop_event.is_set():
                try:
                    # 等待一小段时间或直到有日志需要处理
                    if not self._log_queue.empty():
                        self._process_batch()
                    time.sleep(0.1)  # 优化：100ms间隔检查，降低CPU占用（从20ms增加到100ms）
                except Exception as e:
                    print(f"日志处理循环错误: {str(e)}")

        # 在单独的线程中运行日志处理循环
        self._log_thread = threading.Thread(target=log_processing_worker, daemon=True)
        self._log_thread.start()

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
                        while len(entries) < 100:  # 批量处理100条（从50增加到100）
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
                    self._log_file_handle = open(log_file_path, "a", encoding="utf-8", buffering=1)  # 行缓冲
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

    def stop_processes(self):
        """停止所有由execute_command启动的进程"""
        # 检查是否有活跃的进程
        if not self.active_processes:
            return False  # 没有进程需要停止

        self.add_log("正在终止所有进程...")

        # 刷新日志缓冲区
        self._flush_log_buffer()

        # 设置停止事件
        self._stop_event.set()
        self._log_file_stop_event.set()

        # 首先停止所有输出线程
        for thread in self._output_threads:
            if thread.is_alive():
                # 等待线程自然结束，最多等待2秒
                thread.join(timeout=2.0)

        self._output_threads = []

        # 停止所有异步任务
        if hasattr(self, '_output_tasks'):
            for task in self._output_tasks:
                if not task.done():
                    task.cancel()
            self._output_tasks = []

        # 使用平台特定方式终止进程
        import subprocess
        for proc_info in self.active_processes[:]:  # 使用副本避免遍历时修改
            try:
                process = proc_info['process']
                # 对于异步进程，使用不同的终止方法
                if hasattr(process, 'terminate'):
                    if not process.returncode:  # 如果进程仍在运行
                        process.terminate()

                # 检查进程是否仍在运行
                is_running = False
                if hasattr(process, 'poll'):
                    is_running = process.poll() is None
                elif hasattr(process, 'returncode'):
                    is_running = process.returncode is None
                else:
                    # 对于协程对象，默认认为仍在运行
                    is_running = True

                if is_running:
                    self.add_log(f"终止进程 {proc_info['pid']}: {proc_info['command']}")

                    # 首先使用PowerShell递归终止整个进程树
                    try:
                        result1 = subprocess.run(
                            f"powershell.exe -WindowStyle Hidden -Command \"Get-CimInstance Win32_Process -Filter 'ParentProcessId={proc_info['pid']}' | Select-Object -ExpandProperty Handle | ForEach-Object {{ Stop-Process -Id $_ -Force }}\"",
                            shell=True,
                            stderr=subprocess.PIPE,
                            stdout=subprocess.PIPE,
                            creationflags=subprocess.CREATE_NO_WINDOW,
                            timeout=10  # 添加10秒超时
                        )
                        if result1.stderr and result1.stderr.strip():
                            error_text = result1.stderr.decode('utf-8', errors='replace').strip()
                            # 忽略PowerShell的预期错误
                            ignore_keywords = ["no cim instances", "not found", "没有找到", "不存在", "无法找到"]
                            if not any(ignore_text in error_text.lower() for ignore_text in ignore_keywords):
                                self.add_log(f"PowerShell终止子进程错误: {error_text}")
                    except subprocess.TimeoutExpired:
                        self.add_log(f"PowerShell终止子进程超时: {proc_info['pid']}")

                    # 使用taskkill递归终止进程树
                    try:
                        result2 = subprocess.run(
                            f"taskkill /F /T /PID {proc_info['pid']}",
                            shell=True,
                            stderr=subprocess.PIPE,
                            stdout=subprocess.PIPE,
                            creationflags=subprocess.CREATE_NO_WINDOW,
                            timeout=10  # 添加10秒超时
                        )
                        # 只有当stderr不为空且不是预期的错误消息时才记录错误
                        if result2.stderr and result2.stderr.strip():
                            # 解码错误文本，尝试多种编码
                            error_bytes = result2.stderr
                            error_text = ""
                            for encoding in ['utf-8', 'gbk', 'gb2312', 'latin1']:
                                try:
                                    error_text = error_bytes.decode(encoding).strip()
                                    break
                                except UnicodeDecodeError:
                                    continue

                            if not error_text:
                                error_text = error_bytes.decode('utf-8', errors='replace').strip()

                            # 忽略taskkill的预期错误
                            ignore_keywords = [
                                "not found", "no running", "ûҵ", "没有找到",
                                "不存在", "无法找到", "not running", "process not found"
                            ]
                            if not any(ignore_text in error_text.lower() for ignore_text in ignore_keywords):
                                self.add_log(f"Taskkill终止进程树错误: {error_text}")
                    except subprocess.TimeoutExpired:
                        self.add_log(f"Taskkill终止进程树超时: {proc_info['pid']}")

                    # 等待进程终止，最多等待5秒
                    start_time = time.time()
                    while time.time() - start_time < 5:
                        if hasattr(process, 'poll') and process.poll() is not None:
                            # 同步进程已结束
                            break
                        elif hasattr(process, 'returncode') and process.returncode is not None:
                            # 异步进程已结束
                            break
                        time.sleep(0.1)  # 短暂休眠避免占用过多CPU

                    # 再次检查进程是否仍在运行
                    still_running = True
                    if hasattr(process, 'poll'):
                        still_running = process.poll() is None
                    elif hasattr(process, 'returncode'):
                        still_running = process.returncode is None

                    # 只有当进程确实仍在运行时才报告错误
                    if still_running:
                        self.add_log(f"警告: 进程 {proc_info['pid']} 可能仍在运行")
            except Exception as ex:
                # 只在有实际错误信息时才记录错误
                error_msg = str(ex).strip()
                if error_msg:
                    self.add_log(f"终止进程时出错: {error_msg}")
                # 继续处理其他进程，不因单个进程错误而中断

        # 清空进程列表
        self.active_processes = []
        self.add_log("所有进程已终止")

        # 标记为不再运行
        self.is_running = False

        return True

    def _process_batch(self):
        """处理批量日志条目（快速响应版本）"""
        # 阻止并发处理
        if self._processing:
            return

        self._processing = True
        try:
            # 收集队列中的日志条目
            log_entries = []
            # ⚡ 降低批量大小，提高响应性
            batch_limit = min(20, self._log_queue.qsize())  # 从50降低到20

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

            # 创建日志控件 - 批量创建以提高性能
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

            # 主动限制日志数量
            if len(self.logs.controls) > self._max_log_entries:
                self.logs.controls = self.logs.controls[-self._max_log_entries//2:]

            # 更新处理时间
            self._last_process_time = time.time()

            # ⚡ 立即更新UI，不等待
            if len(new_controls) > 0:
                self._schedule_ui_update_fast()

        except Exception as e:
            import traceback
            print(f"批量处理失败: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")
        finally:
            self._processing = False

    def _schedule_ui_update(self):
        """防抖UI更新（避免频繁更新导致卡顿）"""
        with self._update_lock:
            # 取消之前的定时器（防止线程泄漏）
            if self._update_timer is not None:
                try:
                    self._update_timer.cancel()
                except Exception:
                    pass

            self._update_pending = True

            def do_update():
                try:
                    if hasattr(self, 'view') and self.view.page is not None:
                        self.logs.update()
                        self._last_ui_update = time.time()
                except Exception as e:
                    print(f"UI更新失败: {str(e)}")
                finally:
                    with self._update_lock:
                        self._update_pending = False
                        self._update_timer = None

            # ⚡ 快速更新，减少延迟
            self._update_timer = threading.Timer(0.05, do_update)  # 50ms延迟（从150ms降低）
            self._update_timer.start()

    def _schedule_ui_update_fast(self):
        """快速UI更新（用于实时输出）"""
        with self._update_lock:
            # 如果已经有更新在等待，不重复调度
            if self._update_pending:
                return

            # 取消之前的定时器
            if self._update_timer is not None:
                try:
                    self._update_timer.cancel()
                except Exception:
                    pass

            self._update_pending = True

            def do_update():
                try:
                    if hasattr(self, 'view') and self.view.page is not None:
                        self.logs.update()
                        self._last_ui_update = time.time()
                except Exception as e:
                    print(f"UI更新失败: {str(e)}")
                finally:
                    with self._update_lock:
                        self._update_pending = False
                        self._update_timer = None

            # ⚡ 极速更新：立即执行
            self._update_timer = threading.Timer(0.01, do_update)  # 10ms延迟
            self._update_timer.start()

    def add_log(self, text: str):
        """线程安全的日志添加方法（优化版 - 使用背压机制）"""
        try:
            # 优先处理空值情况
            if not text:
                return

            # 限制单条日志长度并清理多余换行
            processed_text = text[:self.LOG_MAX_LENGTH]
            processed_text = re.sub(r'(\r?\n){3,}', '\n\n', processed_text.strip())

            # 将日志写入文件（通过队列异步处理）
            if self.enable_logging:
                timestamp = datetime.datetime.now()
                try:
                    self._log_file_queue.put_nowait((timestamp, processed_text))
                except queue.Full:
                    # 队列满时丢弃（避免阻塞）
                    pass

            # 超长日志特殊处理
            if len(processed_text) >= self.LOG_MAX_LENGTH:
                self._clear_logs_async()

            # 非阻塞添加到队列（带背压）
            try:
                self._log_queue.put_nowait(processed_text)
            except queue.Full:
                # 队列满时，清空一半旧日志（背压机制）
                with self._log_queue.mutex:
                    # 丢弃最老的一半
                    new_queue = queue.Queue(maxsize=self.MAX_QUEUE_SIZE)
                    items_to_keep = []
                    # 保留最新的500条
                    for _ in range(min(500, self._log_queue.qsize())):
                        try:
                            items_to_keep.append(self._log_queue.get_nowait())
                        except queue.Empty:
                            break
                    # 添加新日志
                    items_to_keep.append(processed_text)
                    # 放回队列
                    for item in items_to_keep:
                        new_queue.put_nowait(item)
                    # 替换队列
                    self._log_queue = new_queue

            # 主动触发日志处理（确保日志及时显示）
            self._trigger_log_processing()

        except (TypeError, IndexError, AttributeError) as e:
            import traceback
            print(f"日志处理异常: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")
        except Exception as e:
            import traceback
            print(f"未知错误: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")

    def _trigger_log_processing(self):
        """主动触发日志处理（确保日志及时显示）"""
        # 如果正在处理中，不需要重复触发
        if self._processing:
            return

        # 根据队列大小和距离上次处理的时间决定是否立即处理
        queue_size = self._log_queue.qsize()
        current_time = time.time()
        time_since_last_process = current_time - self._last_process_time

        # ⚡ 快速触发：降低阈值，提高响应性
        # 如果队列中有日志且满足以下条件之一，则立即处理：
        # 1. 队列中有日志（>=1条，立即处理）
        # 2. 距离上次处理已经超过50ms（从200ms降低到50ms）
        if queue_size > 0 and (queue_size >= 1 or time_since_last_process >= 0.05):
            if not self._processing:
                self._process_batch()

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

        with self._log_queue.mutex:
            self._log_queue.queue.clear()

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
                    formatted_timestamp = timestamp.strftime("%Y-%m-%d %H:%M:%S")
                    clean_text = re.sub(r'\x1b\[[0-9;]*m', '', text)
                    log_lines.append(f"[{formatted_timestamp}] {clean_text}\n")

                # 批量写入并flush
                self._log_file_handle.writelines(log_lines)
                self._log_file_handle.flush()  # 确保写入磁盘

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
