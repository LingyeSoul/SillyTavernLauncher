import flet as ft
import platform
from env import Env
from sysenv import SysEnv
from stconfig import stcfg
from event import UiEvent
from config import ConfigManager
from network import get_local_ip
import os
import subprocess
import datetime
import re
import threading
import queue
import time
import stconfig

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
    def __init__(self, page):
        self.logs = ft.ListView(
            expand=True,
            spacing=5,
            auto_scroll=True,  # 恢复自动滚动
            padding=10
        )
        # 初始化启动时间戳
        self.launch_timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

        # 读取配置以确定是否启用局域网访问
        stcfg_manager = stcfg()
        local_enabled = stconfig.stcfg().listen

        if page.platform == ft.PagePlatform.WINDOWS:
            # 只在启用局域网访问时获取并显示IP
            if local_enabled:
                local_ip = get_local_ip()
                title_text = f"局域网IP：{local_ip}"
            else:
                title_text = ""
            self.view = ft.Column([
                ft.Row([
                        ft.Text("终端", size=24, weight=ft.FontWeight.BOLD),
                        ft.Text(title_text, size=16,color=ft.Colors.BLUE_300),
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
        # 读取配置文件中的日志设置
        config_manager = ConfigManager()
        self.enable_logging = config_manager.get("log", True)
        
        # 异步处理相关属性
        self._log_queue = queue.Queue()  # 使用队列作为缓冲区
        self._last_process_time = 0  # 上次处理时间
        self._process_interval = 0.02  # 处理间隔（秒）- 优化为20ms以提高响应性
        self._processing = False  # 阻止并发处理
        self._batch_size_threshold = 30  # 批量处理阈值 - 调整为30以平衡性能和响应性
        self._stop_event = threading.Event()  # 停止事件
        self._max_log_entries = 1500  # 最大日志条目数 - 调整为1500以减少内存占用
        
        # 日志文件写入线程相关属性
        self._log_file_queue = queue.Queue()
        self._log_file_thread = None
        self._log_file_stop_event = threading.Event()
        
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
                    time.sleep(0.02)  # 20ms间隔检查 - 提高检查频率以提高响应性
                except Exception as e:
                    print(f"日志处理循环错误: {str(e)}")
        
        # 在单独的线程中运行日志处理循环
        self._log_thread = threading.Thread(target=log_processing_worker, daemon=True)
        self._log_thread.start()
        
    def _start_log_file_thread(self):
        """启动日志文件写入线程"""
        def log_file_worker():
            """日志文件写入工作线程"""
            while not self._log_file_stop_event.is_set():
                try:
                    # 批量处理日志文件写入
                    entries = []
                    try:
                        # 先处理一个日志条目
                        entry = self._log_file_queue.get(timeout=0.1)
                        entries.append(entry)
                        
                        # 尝试获取更多日志条目进行批量处理
                        while len(entries) < 50:  # 最多批量处理50条
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
        
        # 启动日志文件写入线程
        self._log_file_thread = threading.Thread(target=log_file_worker, daemon=True)
        self._log_file_thread.start()

    def update_log_setting(self, enabled: bool):
        """更新日志设置"""
        self.enable_logging = enabled

    def stop_processes(self):
        """停止所有由execute_command启动的进程"""
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
                    import time
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
        """处理批量日志条目"""
        # 阻止并发处理
        if self._processing:
            return
            
        # 获取当前时间
        current_time = time.time()
        
        # 检查是否需要处理（基于时间间隔或队列大小）
        queue_size = self._log_queue.qsize()
        time_to_process = (current_time - self._last_process_time) >= self._process_interval
        size_to_process = queue_size >= self._batch_size_threshold
        
        # 如果不需要处理，但队列不为空，强制处理少量日志以确保及时显示
        if not time_to_process and not size_to_process and queue_size > 0:
            # 即使未达到处理条件，如果有日志也处理少量（最多3条）以确保及时显示
            size_to_process = True
            batch_limit = min(3, queue_size)  # 限制处理数量以避免影响性能
        else:
            batch_limit = min(self._batch_size_threshold, queue_size) if queue_size > 0 else self._batch_size_threshold
            
        self._processing = True
        try:
            # 收集队列中的日志条目
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
                
            # 创建日志控件 - 批量创建以提高性能
            new_controls = []
            for processed_text in log_entries:
                if ANSI_ESCAPE_REGEX.search(processed_text):
                    # 解析ANSI颜色代码并创建富文本
                    spans = parse_ansi_text(processed_text)
                    new_text = ft.Text(spans=spans, selectable=True, size=14)
                else:
                    # 普通文本
                    new_text = ft.Text(processed_text, selectable=True, size=14)
                new_controls.append(new_text)
            
            # 批量更新日志控件
            self.logs.controls.extend(new_controls)
            
            # 限制日志数量
            if len(self.logs.controls) > self._max_log_entries:
                # 保留最新的日志条目
                self.logs.controls = self.logs.controls[-self._max_log_entries//2:]  # 保留一半数量
            
            # 更新处理时间
            self._last_process_time = current_time
            
            # 批量更新UI
            if hasattr(self, 'view') and self.view.page is not None:
                try:
                    # 更新UI，让Flet框架自动处理滚动
                    self.logs.update()
                except AssertionError:
                    # 控件未正确附加到页面，跳过更新
                    pass
                except RuntimeError as e:
                    # 事件循环已关闭，跳过更新
                    if "Event loop is closed" not in str(e):
                        raise
                except Exception as e:
                    # 其他UI更新错误，记录但不停止处理
                    print(f"UI更新失败: {str(e)}")
                    import traceback
                    print(f"详细错误信息: {traceback.format_exc()}")
            
        except Exception as e:
            import traceback
            print(f"批量处理失败: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")
        finally:
            # 确保_processing标志被重置
            self._processing = False
            # 如果队列中还有未处理的日志，安排下一次处理
            if not self._log_queue.empty():
                # 使用更积极的调度策略
                self._schedule_batch_process()

    def _schedule_batch_process(self):
        """安排批量处理"""
        if hasattr(self, 'view') and self.view.page is not None:
            try:
                # 定义异步函数用于处理批处理
                async def async_process_batch():
                    self._process_batch()
                
                # 使用run_task执行异步函数
                self.view.page.run_task(async_process_batch)  # 修复：传递函数引用而不是调用结果
            except (AssertionError, RuntimeError, Exception) as e:
                # 检查是否是事件循环关闭错误
                if "Event loop is closed" in str(e):
                    # 如果事件循环已关闭，直接调用_process_batch
                    try:
                        self._process_batch()
                    except Exception as fallback_error:
                        print(f"日志处理失败: {str(fallback_error)}")
                else:
                    # 如果是其他错误，尝试直接调用_process_batch
                    try:
                        self._process_batch()
                    except Exception as fallback_error:
                        print(f"日志处理失败: {str(fallback_error)}")

    def add_log(self, text: str):
        """线程安全的日志添加方法"""  
        import re
        LOG_MAX_LENGTH = 2000  # 单条日志长度限制
        try:
            # 优先处理空值情况
            if not text:
                return
            
            # 限制单条日志长度并清理多余换行
            processed_text = text[:LOG_MAX_LENGTH]
            processed_text = re.sub(r'(\r?\n){3,}', '\n\n', processed_text.strip())
            
            # 将日志写入文件（通过队列异步处理）
            if self.enable_logging:
                timestamp = datetime.datetime.now()
                self._log_file_queue.put((timestamp, processed_text))
            
            # 超长日志特殊处理
            if len(processed_text) >= LOG_MAX_LENGTH:
                # 在UI线程中清理控件
                def clear_logs():
                    try:
                        self.logs.controls.clear()
                        if hasattr(self, 'view') and self.view.page is not None:
                            self.logs.update()
                    except Exception as e:
                        print(f"清空日志失败: {str(e)}")
                
                if hasattr(self, 'view') and self.view.page is not None:
                    try:
                        # 定义异步函数用于清理日志
                        async def async_clear_logs():
                            clear_logs()
                        
                        self.view.page.run_task(async_clear_logs)
                    except (RuntimeError, Exception) as e:
                        # 处理事件循环关闭的情况
                        if "Event loop is closed" in str(e):
                            clear_logs()
                        else:
                            clear_logs()
                        
                with self._log_queue.mutex:
                    self._log_queue.queue.clear()  # 清空队列
            
            # 添加到日志队列
            self._log_queue.put(processed_text)
            
            # 立即安排处理少量日志以确保及时显示
            # 如果队列中有一定数量的日志或者距离上次处理已经有一段时间，则安排处理
            queue_size = self._log_queue.qsize()
            current_time = time.time()
            time_since_last_process = current_time - self._last_process_time
            
            # 如果队列中有日志且满足以下条件之一，则立即处理：
            # 1. 队列中有较多日志（>=3条）
            # 2. 距离上次处理已经超过50ms
            if queue_size > 0 and (queue_size >= 3 or time_since_last_process >= 0.05):
                self._schedule_batch_process()
            # 对于少量日志，也确保不会等待太久才显示
            elif queue_size > 0:
                # 使用threading.Timer安排延迟处理，确保即使没有达到批量阈值也能及时处理
                if hasattr(self, 'view') and self.view.page is not None:
                    try:
                        # 使用threading.Timer替代page.after（因为Page没有after方法）
                        timer = threading.Timer(0.03, self._schedule_batch_process)  # 30ms后处理
                        timer.start()
                    except:
                        # 如果定时器设置失败，则直接安排处理
                        self._schedule_batch_process()
            
        except (TypeError, IndexError, AttributeError) as e:
            import traceback
            print(f"日志处理异常: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")
        except Exception as e:
            import traceback
            print(f"未知错误: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")
    
    def _write_log_entries_to_file(self, entries):
        """将一批日志条目写入文件"""
        # 检查是否启用日志输出
        if not self.enable_logging:
            return
            
        try:
            # 创建logs目录（如果不存在）
            logs_dir = os.path.join(os.getcwd(), "logs")
            os.makedirs(logs_dir, exist_ok=True)
            
            # 生成基于启动时间戳的文件名
            log_file_path = os.path.join(logs_dir, f"{self.launch_timestamp}.log")
            
            # 准备日志内容
            log_lines = []
            for timestamp, text in entries:
                # 格式化时间戳
                formatted_timestamp = timestamp.strftime("%Y-%m-%d %H:%M:%S")
                
                # 移除ANSI颜色代码
                clean_text = re.sub(r'\x1b\[[0-9;]*m', '', text)
                
                # 添加到日志行
                log_lines.append(f"[{formatted_timestamp}] {clean_text}\n")
            
            # 写入文件
            with open(log_file_path, "a", encoding="utf-8") as log_file:
                log_file.writelines(log_lines)
                
        except Exception as e:
            # 如果写入日志文件失败，不中断主流程，只在控制台输出错误
            print(f"写入日志文件失败: {str(e)}")
    
    def _write_log_to_file(self, text: str):
        """将日志写入文件（已废弃，保留向后兼容性）"""
        # 此方法已废弃，现在使用队列异步处理日志写入
        # 保留此方法以确保向后兼容性
        if self.enable_logging:
            timestamp = datetime.datetime.now()
            self._log_file_queue.put((timestamp, text))
    
    def _flush_log_buffer(self):
        """刷新日志缓冲区，确保所有日志都被写入文件"""
        # 等待日志文件队列处理完毕
        while not self._log_file_queue.empty() and not self._log_file_stop_event.is_set():
            time.sleep(0.01)  # 等待队列处理完成

class UniUI():
    def __init__(self,page,ver,version_checker):
        self.page = page
        self.env = Env()
        self.version_checker = version_checker
        self.version = ver
        self.sysenv = SysEnv()
        self.stcfg = stcfg()
        self.platform = platform.system()
        self.terminal = AsyncTerminal(page)  # 使用异步终端替换高性能终端
        self.config_manager = ConfigManager()
        self.config = self.config_manager.config
        self.ui_event = UiEvent(self.page, self.terminal, self)
        self.BSytle=ft.ButtonStyle(icon_size=25,text_style=ft.TextStyle(size=20,font_family="Microsoft YaHei"))
        self.port_field = ft.TextField(
            label="监听端口",
            width= 610,
            value=str(self.stcfg.port),
            hint_text="默认端口: 8000",
        )
        self.proxy_url_field = ft.TextField(
            label="代理URL",
            width= 610,
            value=str(self.stcfg.proxy_url),
            hint_text="有效的代理URL，支持http, https, socks, socks5, socks4, pac",
        )

    def getSettingView(self):
        if self.platform == "Windows":
            return ft.Column([
                ft.Text("设置", size=24, weight=ft.FontWeight.BOLD),
                ft.Divider(),
                ft.Column([
                    ft.Text("GitHub镜像源选择", size=18, weight=ft.FontWeight.BOLD),
                    ft.Text("推荐使用镜像站获得更好的下载速度", size=14, color=ft.Colors.GREY_600),
                    ft.DropdownM2(
                        options=[
                            ft.dropdown.Option("github", "官方源 (github.com) - 可能较慢"),
                            ft.dropdown.Option("gh-proxy.org", "镜像站点1 (gh-proxy.org)"),
                            ft.dropdown.Option("ghfile.geekertao.top", "镜像站点2 (ghfile.geekertao.top)"),
                            ft.dropdown.Option("gh.dpik.top", "镜像站点3 (gh.dpik.top)"),
                            ft.dropdown.Option("github.dpik.top", "镜像站点4 (github.dpik.top)"),
                            ft.dropdown.Option("github.acmsz.top", "镜像站点5 (github.acmsz.top)"),
                            ft.dropdown.Option("git.yylx.win", "镜像站点6 (git.yylx.win)"),
                        ],
                        value=self.config_manager.get("github.mirror"),
                        on_change=self.ui_event.update_mirror_setting
                    ),
                    ft.Text("当不使用官方源时，将使用镜像源加速下载", size=14, color=ft.Colors.BLUE_400),
                    ft.Divider(),
                    ft.Text("环境设置", size=18, weight=ft.FontWeight.BOLD),
                    ft.Text("懒人包请勿修改，此处供已安装Git和Nodejs的用户修改", size=14, color=ft.Colors.GREY_600),
                    ft.Row(
                        controls=[
                            ft.Switch(
                                label="使用系统环境",
                                value=self.config_manager.get("use_sys_env", False),
                                on_change=self.ui_event.env_changed,
                            ),
                            ft.Switch(
                                label="启用修改Git配置文件",
                                value=self.config_manager.get("patchgit", False),
                                on_change=self.ui_event.patchgit_changed,
                            )
                        ],
                        spacing=5,
                        scroll=ft.ScrollMode.AUTO
                    ),
                    ft.Text("懒人包请勿修改，修改后重启生效 | 开启后修改系统环境的Git配置文件", size=14, color=ft.Colors.BLUE_400),
                    ft.Divider(),
                    ft.Text("酒馆网络设置", size=18, weight=ft.FontWeight.BOLD),
                    ft.Text("调整酒馆网络设置，重启酒馆生效", size=14, color=ft.Colors.GREY_600),
                    ft.Switch(
                        label="启用局域网访问",
                        value=self.stcfg.listen,
                        on_change=self.ui_event.listen_changed,
                    ),
                    ft.Text("开启后自动生成whitelist.txt(如有，则不会生成)，放行192.168.*.*，关闭后不会删除", size=14, color=ft.Colors.BLUE_400),
                    ft.Row([
                        self.port_field,
                        ft.IconButton(
                            icon=ft.Icons.SAVE,
                            tooltip="保存端口设置",
                            on_click=lambda e: self.ui_event.save_port(self.port_field.value)
                        )
                    ]),
                    ft.Text("监听端口一般情况下不需要修改，请勿乱动", size=14, color=ft.Colors.BLUE_400),
                    ft.Switch(
                        label="自动设置请求代理",
                        value=self.config_manager.get("auto_proxy", False),
                        on_change=self.ui_event.auto_proxy_changed,
                    ),
                    ft.Text("开启后酒馆的请求会走启动器自动识别的系统代理", size=14, color=ft.Colors.BLUE_400),
                    ft.Row([
                        ft.TextField(
                            label="自定义启动参数",
                            width=610,
                            value=self.config_manager.get("custom_args", ""),
                            hint_text="在此输入自定义启动参数，将添加到启动命令中，如果你不清楚，请留空！",
                            on_change=self.ui_event.custom_args_changed,
                        ),
                        ft.IconButton(
                            icon=ft.Icons.SAVE,
                            tooltip="保存自定义启动参数",
                            on_click=lambda e: self.ui_event.save_custom_args(self.config_manager.get("custom_args", ""))
                        )
                    ]),
                    ft.Text("自定义启动参数将添加到启动命令末尾", size=14, color=ft.Colors.BLUE_400),
                    ft.Divider(),
                    ft.Text("启动器功能设置", size=18, weight=ft.FontWeight.BOLD),
                    ft.Switch(
                        label="启用日志",
                        value=self.config_manager.get("log", True),
                        on_change=self.ui_event.log_changed,
                    ),
                    ft.Text("开启后会在logs文件夹生成每次运行时的终端日志，在反馈时可以发送日志。", size=14, color=ft.Colors.BLUE_400),
                    ft.Switch(
                        label="自动检查启动器更新",
                        value=self.config_manager.get("checkupdate", True),
                        on_change=self.ui_event.checkupdate_changed,
                    ),
                    ft.Text("开启后在每次启动启动器时会自动检查更新并提示(启动器并不会自动安装更新，请手动下载并更新)", size=14, color=ft.Colors.BLUE_400),
                    ft.Switch(
                        label="自动检查酒馆更新",
                        value=self.config_manager.get("stcheckupdate", True),
                        on_change=self.ui_event.stcheckupdate_changed,
                    ),
                    ft.Text("开启后在每次启动酒馆时先进行更新操作再启动酒馆", size=14, color=ft.Colors.BLUE_400),
                    ft.Switch(
                        label="启用系统托盘",
                        value=self.config_manager.get("tray", True),
                        on_change=self.ui_event.tray_changed,
                    ),
                    ft.Text("开启后将在系统托盘中显示图标，可快速退出程序", size=14, color=ft.Colors.BLUE_400),
                    ft.Switch(
                        label="启用自动启动",
                        value=self.config_manager.get("autostart", False),
                        on_change=self.ui_event.autostart_changed,
                    ),
                    ft.Text("在打开托盘的状态下，启动启动器时，会自动隐藏窗口并静默启动酒馆", size=14, color=ft.Colors.BLUE_400),
                    ft.Divider(),
                    ft.Text("辅助功能", size=18, weight=ft.FontWeight.BOLD),
                    ft.Row(
                        controls=[
                            ft.ElevatedButton(
                                "检查系统环境",
                                icon=ft.Icons.SETTINGS,
                                style=self.BSytle,
                                on_click=self.ui_event.sys_env_check,
                                height=40
                            ),
                            ft.ElevatedButton(
                                "检查内置环境",
                                icon=ft.Icons.SETTINGS,
                                style=self.BSytle,
                                on_click=self.ui_event.in_env_check,
                                height=40
                            ),
                            ft.ElevatedButton(
                                "启动命令行",
                                icon=ft.Icons.SETTINGS,
                                style=self.BSytle,
                                on_click=self.ui_event.start_cmd,
                                height=40
                            )
                        ],
                        spacing=5,
                        scroll=ft.ScrollMode.AUTO
                    ),
                ], spacing=15, expand=True, scroll=ft.ScrollMode.AUTO)
            ], spacing=15, expand=True)
        
    def getTerminalView(self):
        if self.platform == "Windows":
            return[self.terminal.view,
                   ft.Row(
            [ 
                        ft.ElevatedButton(
                            "安装",
                            icon=ft.Icons.DOWNLOAD,
                            tooltip="从仓库拉取最新版本并安装依赖",
                            style=self.BSytle,
                            on_click=self.ui_event.install_sillytavern,
                            height=50,
                        ),
                        ft.ElevatedButton(
                            "启动",
                            icon=ft.Icons.PLAY_ARROW,
                            tooltip="启动SillyTavern",
                            style=self.BSytle,
                            on_click=self.ui_event.check_and_start_sillytavern if self.config_manager.get('stcheckupdate', True) else self.ui_event.start_sillytavern,
                            height=50,
                        ),
                        ft.ElevatedButton(
                            "停止",
                            icon=ft.Icons.CANCEL,
                            tooltip="停止SillyTavern",
                            style=self.BSytle,
                            on_click=self.ui_event.stop_sillytavern,
                            height=50,
                        ),
                        ft.ElevatedButton(
                            "更新",
                            icon=ft.Icons.UPDATE,
                            tooltip="更新到最新版本并更新依赖",
                            style=self.BSytle,
                            on_click=self.ui_event.update_sillytavern,
                            height=50,
                        ),
                        ],
            alignment=ft.MainAxisAlignment.CENTER,
            expand=True 
        ),
        ]
        


    def getAboutView(self):
        # 创建版本检查函数
        def check_for_updates(e):
            import threading
            # 使用同步方法进行更新检查
            update_thread = threading.Thread(target=self.version_checker.run_check_sync)
            update_thread.daemon = True
            update_thread.start()

        if self.platform == "Windows":
            return ft.Column([
        ft.Text("关于", size=24, weight=ft.FontWeight.BOLD),
        ft.Divider(),
        ft.Text("SillyTavernLauncher", size=20, weight=ft.FontWeight.BOLD),
        ft.Text(value=f"版本: {self.version}", size=16),
        ft.Text("作者: 泠夜Soul", size=16),
        ft.ElevatedButton(
            "访问GitHub仓库",
            icon=ft.Icons.OPEN_IN_BROWSER,
            on_click=lambda e: e.page.launch_url("https://github.com/LingyeSoul/SillyTavernLauncher", web_window_name="github"),
            style=self.BSytle,
            height=40
        ),
        ft.ElevatedButton(
            "访问启动器官网",
            icon=ft.Icons.OPEN_IN_BROWSER,
            on_click=lambda e: e.page.launch_url("https://sillytavern.lingyesoul.top", web_window_name="sillytavernlanuncher"),
            style=self.BSytle,
            height=40
        ),
        ft.ElevatedButton(
            "访问作者B站",
            icon=ft.Icons.OPEN_IN_BROWSER,
            on_click=lambda e: e.page.launch_url("https://space.bilibili.com/298721157", web_window_name="bilibili"),
            style=self.BSytle,
            height=40
        ),
        ft.ElevatedButton(
            "酒馆入门教程",
            icon=ft.Icons.BOOK_ROUNDED,
            on_click=lambda e: e.page.launch_url("https://www.yuque.com/yinsa-0wzmf/rcv7g3?", web_window_name="sillytaverntutorial"),
            style=self.BSytle,
            height=40
        ),
        ft.ElevatedButton(
            "打赏作者",
            icon=ft.Icons.ATTACH_MONEY,
            on_click=lambda e: e.page.launch_url("https://ifdian.net/order/create?user_id=8a03ea64ebc211ebad0e52540025c377", web_window_name="afdian"),
            style=self.BSytle,
            height=40
        ),
        ft.ElevatedButton(
            "检查更新",
            icon=ft.Icons.UPDATE,
            on_click=check_for_updates,
            style=self.BSytle,
            height=40
        ),
    ], spacing=15, expand=True)
    
    def setMainView(self, page):
        if self.platform == "Windows":
            # 创建简化的初始UI - 非阻塞
            self._create_minimal_ui(page)

            # 异步加载复杂视图
            import threading
            threading.Thread(target=self._load_views_async, args=(page,), daemon=True).start()

    def _create_minimal_ui(self, page):
        """创建最小化初始UI - 优先加载主题和Appbar控制"""

        # 优先设置主题模式
        page.theme_mode = self.config_manager.get("theme")

        # 优先创建主题图标
        if not self.config_manager.get("theme") == "light":
            themeIcon = ft.Icons.SUNNY
        else:
            themeIcon = ft.Icons.MODE_NIGHT

        # 优先创建最小化函数
        def minisize(e):
            try:
                page.window.minimized = True
                page.update()
            except AssertionError:
                # 处理Flet框架中可能出现的AssertionError异常
                try:
                    # 尝试另一种方式最小化窗口
                    page.window.visible = False
                    page.update()
                    page.window.visible = True
                    page.window.minimized = True
                    page.update()
                except Exception as inner_e:
                    import traceback
                    print(f"最小化窗口失败: {str(inner_e)}")
                    print(f"错误详情: {traceback.format_exc()}")
            except Exception as e:
                import traceback
                print(f"最小化窗口失败: {str(e)}")
                print(f"错误详情: {traceback.format_exc()}")

        # 设置窗口事件
        def window_event(e):
            if e.data == "close":
                # 检查是否启用了托盘功能
                if self.config_manager.get("tray", True):
                    # 启用托盘时，只隐藏窗口
                    page.window.visible = False
                    page.update()
                else:
                    # 未启用托盘时，正常退出程序
                    self.ui_event.exit_app(e)
        page.window.prevent_close = True
        page.window.on_event = window_event

        # 优先设置Appbar
        page.appbar = ft.AppBar(
            #leading=ft.Icon(ft.Icons.PALETTE),
            leading_width=40,
            title=ft.WindowDragArea(content=ft.Text("SillyTavernLauncher"), width=800),
            center_title=False,
            bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
            actions=[
                ft.IconButton(ft.Icons.MINIMIZE, on_click=minisize, icon_size=30),
                ft.IconButton(icon=themeIcon, on_click=self.ui_event.switch_theme, icon_size=30),
                ft.IconButton(ft.Icons.CANCEL_OUTLINED, on_click=self.ui_event.exit_app, icon_size=30),
            ],
        )

        # 创建导航栏（简化版）
        rail = ft.NavigationRail(
            selected_index=0,
            label_type=ft.NavigationRailLabelType.ALL,
            min_width=50,
            min_extended_width=50,
            extended=False,
            destinations=[
                ft.NavigationRailDestination(
                    icon=ft.Icons.TERMINAL,
                    selected_icon=ft.Icons.TERMINAL,
                    label="终端"
                ),
                ft.NavigationRailDestination(
                    icon=ft.Icons.SYNC,
                    selected_icon=ft.Icons.SYNC,
                    label="同步"
                ),
                ft.NavigationRailDestination(
                    icon=ft.Icons.SETTINGS,
                    selected_icon=ft.Icons.SETTINGS,
                    label="设置"
                ),
                ft.NavigationRailDestination(
                    icon=ft.Icons.INFO,
                    selected_icon=ft.Icons.INFO,
                    label="关于"
                ),
            ],
            on_change=lambda e: self._handle_view_change(e.control.selected_index)
        )

        # 初始只显示终端视图
        terminal_view = self.getTerminalView()
        content = ft.Column(terminal_view, expand=True)

        # 存储引用供异步加载使用
        self._page = page
        self._rail = rail
        self._content = content
        self._terminal_view = terminal_view
        self._views_loaded = False

        # 添加到页面
        page.add(
            ft.Row(
                [
                    rail,
                    ft.VerticalDivider(width=1),
                    content
                ],
                expand=True,
                alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                vertical_alignment=ft.CrossAxisAlignment.STRETCH
            )
        )

    def _handle_view_change(self, index):
        """处理视图切换 - 支持延迟加载"""
        if not hasattr(self, '_views_loaded') or not self._views_loaded:
            # 如果视图还未加载完成，显示加载提示
            self._content.controls.clear()
            loading_content = ft.Container(
                ft.Column([
                    ft.Text("正在加载...", size=16, weight=ft.FontWeight.BOLD),
                    ft.ProgressBar(visible=True)
                ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                height=400,
                alignment=ft.alignment.center
            )
            self._content.controls.append(loading_content)
            self._page.update()
            return

        # 正常切换视图
        self._content.controls.clear()
        if index == 0:
            self._content.controls.extend(self._terminal_view)
        elif index == 1 and hasattr(self, 'sync_view'):
            self._content.controls.append(self.sync_view)
        elif index == 2 and hasattr(self, 'settings_view'):
            self._content.controls.append(self.settings_view)
        elif index == 3 and hasattr(self, 'about_view'):
            self._content.controls.append(self.about_view)

        self._page.update()

    def _load_views_async(self, page):
        """异步加载复杂视图 - 主题和Appbar已优先加载，此处跳过"""
        try:
            # 延迟创建同步管理器 - 带错误处理
            try:
                from sync_ui import DataSyncUI
                import os
                data_dir = os.path.join(os.getcwd(), "SillyTavern", "data", "default-user")
                self.sync_ui = DataSyncUI(data_dir, self.config_manager)
                self.sync_view = self.sync_ui.create_ui(page)
            except Exception as e:
                print(f"同步功能初始化失败，将显示简化界面: {e}")
                # 创建简化的同步界面
                self.sync_view = self._create_simple_sync_view()
            
            # 延迟创建设置视图（最复杂）
            self.settings_view = self.getSettingView()

            # 延迟创建关于视图
            self.about_view = self.getAboutView()

            # 标记加载完成
            self._views_loaded = True

            # 如果当前正在显示加载界面，切换到对应视图
            if page and hasattr(self, '_rail'):
                def update_ui():
                    try:
                        # 获取当前选中的索引
                        current_index = self._rail.selected_index
                        # 重新处理视图切换
                        self._handle_view_change(current_index)
                    except Exception as e:
                        print(f"更新UI失败: {e}")

                # 在主线程中更新UI
                if page:
                    update_ui()

        except Exception as e:
            print(f"异步加载视图失败: {e}")
            import traceback
            traceback.print_exc()
            # 如果加载失败，确保UI仍然可用
            def show_error():
                if page:
                    self._content.controls.clear()
                    error_content = ft.Container(
                        ft.Column([
                            ft.Text("加载部分界面失败", size=16, color=ft.Colors.RED_500),
                            ft.Text(str(e), size=14),
                            ft.Text("请重启应用或联系开发者", size=14),
                            ft.ElevatedButton(
                                "重试",
                                on_click=lambda _: threading.Thread(
                                    target=self._load_views_async,
                                    args=(page,),
                                    daemon=True
                                ).start()
                            )
                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                        height=400,
                        alignment=ft.alignment.center
                    )
                    self._content.controls.append(error_content)
                    page.update()

            if page:
                show_error()

    def _create_simple_sync_view(self):
        """Create a simplified sync view when full sync initialization fails"""
        return ft.Column([
            ft.Text("数据同步", size=24, weight=ft.FontWeight.BOLD),
            ft.Divider(),
            ft.Container(
                ft.Column([
                    ft.Icon(ft.Icons.SYNC_PROBLEM, size=48, color=ft.Colors.ORANGE_400),
                    ft.Text("同步功能初始化失败", size=16, weight=ft.FontWeight.BOLD, color=ft.Colors.ORANGE_600),
                ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=15),
                padding=20,
                border_radius=10,
            )
        ], scroll=ft.ScrollMode.AUTO, expand=True, spacing=15)    