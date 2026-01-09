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
    # 性能优化常量（简化版 - 移除过载阈值）
    MAX_LOG_ENTRIES = 200  # UI最多显示200条
    LOG_MAX_LENGTH = 1000  # 单条日志长度限制
    LOG_MAX_LENGTH_DETAILED = 5000  # 详细日志（如traceback）的长度限制
    BATCH_SIZE_THRESHOLD = 50  # 批量处理阈值
    PROCESS_INTERVAL = 0.05  # 处理间隔50ms

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
        self._output_threads = []  # 存储输出处理线程
        self.enable_logging = enable_logging

        # DEBUG 模式控制
        self._debug_mode = False  # 是否启用 DEBUG 模式（显示所有 DEBUG 信息）

        # 进程监控相关
        self._process_monitor_thread = None
        self._process_monitor_stop_event = threading.Event()
        self._start_process_monitor()

        # 异步处理相关属性 - 使用无界队列（简化版）
        self._log_queue = queue.Queue()  # 无界队列，避免背压
        self._last_process_time = time.time()  # 初始化为当前时间，避免第一次时间差计算异常
        self._process_interval = self.PROCESS_INTERVAL
        self._processing = False  # 阻止并发处理
        self._batch_size_threshold = self.BATCH_SIZE_THRESHOLD
        self._max_log_entries = self.MAX_LOG_ENTRIES
        self._page_ready = False  # 页面就绪标志
        self._schedule_retry_count = 0  # 调度重试计数

        # 日志文件写入线程相关属性
        self._log_file_queue = queue.Queue()  # 无界队列
        self._log_file_thread = None
        self._log_file_stop_event = threading.Event()
        self._log_file_handle = None  # 文件句柄，保持打开以减少I/O
        self._log_file_lock = threading.Lock()

        # 添加_stop_event用于停止后台日志处理线程
        self._stop_event = threading.Event()

        # 启动日志文件写入线程
        if self.enable_logging:
            self._start_log_file_thread()

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

    def _start_process_monitor(self):
        """启动进程监控线程，定期检查进程状态"""
        def process_monitor_worker():
            """进程监控工作线程"""
            while not self._process_monitor_stop_event.is_set():
                try:
                    if self.is_running and self.active_processes:
                        # 检查是否有进程已经退出
                        all_stopped = True
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
                                break
                            else:
                                # 进程已退出，记录日志
                                self.add_log(f"[DEBUG] 进程 PID={pid} 已退出")

                        # 如果所有进程都已停止，更新状态
                        if all_stopped:
                            if self.is_running:
                                self.add_log("检测到所有进程已停止")
                                self.is_running = False

                    time.sleep(1.0)  # 每秒检查一次
                except Exception as e:
                    print(f"进程监控线程错误: {str(e)}")

        # 启动进程监控线程
        self._process_monitor_thread = threading.Thread(target=process_monitor_worker, daemon=True)
        self._process_monitor_thread.start()

    def _stop_process_monitor(self):
        """停止进程监控线程"""
        if self._process_monitor_thread and self._process_monitor_thread.is_alive():
            self._process_monitor_stop_event.set()
            self._process_monitor_thread.join(timeout=2.0)

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

        # 设置停止事件（停止后台日志处理线程）
        self._stop_event.set()
        
        # 设置停止事件（仅日志文件线程）
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

        return True

    def _process_batch(self):
        """处理批量日志条目（简化的自适应批量）"""
        # 阻止并发处理
        if self._processing:
            return

        self._processing = True
        try:
            queue_size = self._log_queue.qsize()

            # 简化的自适应批量大小（3档）
            if queue_size > 100:
                batch_limit = 50  # 高负载
            elif queue_size > 30:
                batch_limit = 30  # 中负载
            else:
                batch_limit = 15  # 低负载

            batch_limit = min(batch_limit, queue_size)

            # 如果队列为空，直接返回
            if batch_limit == 0:
                return

            # 收集日志条目
            log_entries = []
            for _ in range(batch_limit):
                try:
                    entry = self._log_queue.get_nowait()
                    log_entries.append(entry)
                except queue.Empty:
                    break

            if not log_entries:
                return

            # 添加调试日志
            print(f"[DEBUG] _process_batch: 队列={queue_size}, 取出={len(log_entries)}")

            # 创建日志控件（限制每次创建的数量，避免UI卡顿）
            new_controls = []
            max_controls_per_batch = 20  # 每次最多创建20个控件

            for i, text in enumerate(log_entries):
                if i >= max_controls_per_batch:
                    # 超过限制，将剩余日志放回队列
                    for remaining_text in log_entries[i:]:
                        try:
                            self._log_queue.put_nowait(remaining_text)
                        except queue.Full:
                            pass
                    break

                if ANSI_ESCAPE_REGEX.search(text):
                    spans = parse_ansi_text(text)
                    new_controls.append(ft.Text(spans=spans, selectable=True, size=14))
                else:
                    new_controls.append(ft.Text(text, selectable=True, size=14))

            # 检查是否创建了任何控件
            if not new_controls:
                print(f"[DEBUG] 未创建任何控件")
                return

            # 更新UI
            self.logs.controls.extend(new_controls)
            print(f"[DEBUG] 创建了 {len(new_controls)} 个控件，总计 {len(self.logs.controls)}")

            # 限制日志数量（使用del而不是列表替换，避免ListView内部状态问题）
            if len(self.logs.controls) > self.MAX_LOG_ENTRIES:
                excess_count = len(self.logs.controls) - self.MAX_LOG_ENTRIES
                del self.logs.controls[:excess_count]
                print(f"[DEBUG] 删除了 {excess_count} 个旧控件")

            self._last_process_time = time.time()

            # 更新UI（增强的错误处理）
            try:
                # 使用 try-except 保护整个 UI 更新流程
                if (hasattr(self, 'view') and
                    self.view is not None and
                    hasattr(self.view, 'page') and
                    self.view.page is not None and
                    not getattr(self.view.page, 'closed', False)):
                    # 页面可用，尝试更新 UI
                    print(f"[DEBUG] 尝试更新UI，控件数: {len(self.logs.controls)}")
                    self.logs.update()
                    print(f"[DEBUG] UI更新成功")
                else:
                    print(f"[DEBUG] 页面不可用，跳过UI更新")
            except (RuntimeError, AssertionError, AttributeError) as e:
                # 已知的 UI 更新错误，静默处理
                print(f"[DEBUG] UI更新错误 ({type(e).__name__}): {str(e)}")
            except Exception as e:
                # 其他未知错误，打印日志但不中断处理
                print(f"[DEBUG] UI更新异常: {type(e).__name__}: {str(e)}")

        except Exception as e:
            import traceback
            print(f"批量处理失败: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")
        finally:
            self._processing = False
            # 如果队列已空，滚动到底部（仅在长队列处理完成时滚动）
            if (self._log_queue.empty() and
                hasattr(self, 'view') and
                self.view is not None and
                hasattr(self.view, 'page') and
                self.view.page is not None and
                not getattr(self.view.page, 'closed', False)):
                try:
                    self.logs.scroll_to(offset=-1, duration=0)
                    print(f"[DEBUG] 队列处理完成，滚动到底部")
                except Exception as scroll_ex:
                    print(f"[DEBUG] 滚动失败: {scroll_ex}")

            # 如果队列中还有未处理的日志且未关闭，继续处理
            if not self._log_queue.empty() and not self._stop_event.is_set():
                self._schedule_batch_process()

    def _schedule_batch_process(self):
        """安排批量处理（使用 page.run_task 确保在主线程执行）"""
        # 检查是否正在关闭
        if self._stop_event.is_set():
            return

        # 如果正在处理中，跳过（快速检查，避免竞争）
        if self._processing:
            return

        # 检查页面是否可用（增强的错误处理）
        page_available = False
        try:
            # 分步检查，避免在 hasattr 本身抛出 RuntimeError
            if not (hasattr(self, 'view') and self.view is not None):
                page_available = False
            elif not hasattr(self.view, 'page'):
                page_available = False
            elif self.view.page is None:
                page_available = False
            elif getattr(self.view.page, 'closed', False):
                page_available = False
            else:
                page_available = True
        except (RuntimeError, AttributeError) as e:
            # Column 控件未附加到页面，或其他属性访问错误
            page_available = False
        except Exception as e:
            # 其他未知错误
            print(f"[DEBUG] 页面可用性检查异常: {type(e).__name__}: {str(e)}")
            page_available = False

        # 如果页面不可用，使用定时器重试
        if not page_available:
            # 检查是否正在关闭
            if self._stop_event.is_set():
                return

            # 限制重试次数，避免无限循环
            if self._schedule_retry_count < 200:  # 最多重试 200 次（4秒）
                self._schedule_retry_count += 1
                try:
                    # 使用更短的重试间隔（20ms）提高响应速度
                    threading.Timer(0.02, self._schedule_batch_process).start()
                except Exception:
                    # 如果定时器失败，不再重试
                    pass
            else:
                # 重试次数过多，放弃重试
                print(f"[DEBUG] 页面重试次数过多，放弃")
                self._schedule_retry_count = 0
            return

        # 页面可用，重置重试计数
        if not self._page_ready:
            self._page_ready = True
            self._schedule_retry_count = 0
            print(f"[DEBUG] 页面首次就绪，_page_ready 设为 True")

        try:
            # 再次检查是否正在关闭
            if self._stop_event.is_set():
                return

            # 定义异步函数用于处理批处理
            async def async_process_batch():
                self._process_batch()

            # 使用 page.run_task() 确保在主线程执行
            self.view.page.run_task(async_process_batch)
        except (AssertionError, RuntimeError) as e:
            # 对于已知的运行时错误，不再重试
            error_msg = str(e)
            # 只打印关键错误，避免刷屏
            if "destroyed" in error_msg.lower() or "closed" in error_msg.lower():
                # 页面已销毁，静默处理
                pass
            elif "assertion" not in error_msg.lower():
                print(f"[DEBUG] 日志调度失败: {error_msg}")
        except Exception as e:
            # 其他异常，只打印一次
            print(f"[DEBUG] 日志调度异常: {type(e).__name__}: {str(e)}")

    def _schedule_ui_update(self):
        """触发 UI 更新"""
        # 直接调用 batch process
        self._schedule_batch_process()

    def _schedule_ui_update_fast(self):
        """触发快速 UI 更新"""
        # 直接调用 batch process
        self._schedule_batch_process()

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

    def add_log(self, text: str):
        """线程安全的日志添加方法（简化版 - 移除激进截断，保留DEBUG过滤）"""
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

            # 简化的队列管理（无界队列，无激进截断）
            self._log_queue.put(processed_text)

            # 智能调度处理（优化第一次响应）
            queue_size = self._log_queue.qsize()
            current_time = time.time()
            time_since_last_process = current_time - self._last_process_time

            # 检查是否应该调度
            should_schedule = False
            schedule_reason = ""

            if not self._page_ready:
                # 页面未就绪时，立即调度以提高响应速度
                should_schedule = True
                schedule_reason = "页面未就绪"
            elif queue_size > 0 and (queue_size >= 3 or time_since_last_process >= 0.05):
                # 页面已就绪，使用正常的批量处理逻辑
                should_schedule = True
                schedule_reason = f"队列={queue_size}, 时间差={time_since_last_process:.3f}"
            elif queue_size > 0:
                # 对于少量日志，也立即调度（确保及时显示）
                should_schedule = True
                schedule_reason = "队列有日志"

            if should_schedule:
                # 立即调度
                try:
                    self._schedule_batch_process()
                except Exception as ex:
                    print(f"[DEBUG] 调度失败 ({schedule_reason}): {ex}")

        except (TypeError, IndexError, AttributeError) as e:
            import traceback
            print(f"日志处理异常: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")
        except Exception as e:
            import traceback
            print(f"未知错误: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")

    def _trigger_log_processing(self):
        """主动触发日志处理（自适应触发）"""
        # 如果正在处理中，不需要重复触发
        if self._processing:
            return

        queue_size = self._log_queue.qsize()
        current_time = time.time()
        time_since_last_process = current_time - self._last_process_time

        # ⚡ 自适应触发阈值：根据队列深度动态调整
        if queue_size > 100:
            # 高负载：等待积累更多或超时
            threshold = 50
            timeout = 0.15  # 150ms
        elif queue_size > 50:
            # 中负载：中等阈值
            threshold = 20
            timeout = 0.1  # 100ms
        else:
            # 低负载：快速响应
            threshold = 5
            timeout = 0.05  # 50ms

        if queue_size > 0 and (queue_size >= threshold or time_since_last_process >= timeout):
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
