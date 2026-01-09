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
            if hasattr(self, 'view') and self.view.page is not None:
                try:
                    self.logs.update()
                except AssertionError:
                    pass
                except RuntimeError as e:
                    if "Event loop is closed" not in str(e):
                        raise

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
        if hasattr(self, 'view') and self.view.page is not None:
            try:
                async def async_process_batch():
                    self._process_batch()

                self.view.page.run_task(async_process_batch)
            except (AssertionError, RuntimeError, Exception) as e:
                if "Event loop is closed" in str(e):
                    try:
                        self._process_batch()
                    except Exception as fallback_error:
                        print(f"日志处理失败: {str(fallback_error)}")
                else:
                    try:
                        self._process_batch()
                    except Exception as fallback_error:
                        print(f"日志处理失败: {str(fallback_error)}")

    # ============ 进程管理 ============

    def stop_processes(self):
        """停止所有进程（多阶段终止策略）"""
        if not self.active_processes:
            return False

        self.add_log("正在终止所有进程...")

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

        self.is_running = False
        self._stop_event.clear()

        return True

    # ============ 公共API方法 ============

    def enable_debug_mode(self, enabled=True):
        """启用或禁用 DEBUG 模式"""
        self._debug_mode = enabled
        if enabled:
            self.add_log("[DEBUG] DEBUG 模式已启用 - 将显示所有调试信息")
        else:
            self.add_log("[DEBUG] DEBUG 模式已禁用 - 将隐藏调试信息")

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

            # 添加到队列
            self._log_queue.put(processed_text)

            # 立即安排处理少量日志
            queue_size = self._log_queue.qsize()
            current_time = time.time()

            if queue_size > 0 and (queue_size >= 3 or (current_time - self._last_process_time) >= 0.05):
                self._schedule_batch_process()
            elif queue_size > 0:
                if hasattr(self, 'view') and self.view.page is not None:
                    try:
                        timer = threading.Timer(0.03, self._schedule_batch_process)
                        timer.start()
                    except:
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