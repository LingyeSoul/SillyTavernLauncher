#!/usr/bin/env python3
"""
SillyTavern Data Sync UI
Flet-based user interface for data synchronization
"""

import os
import threading
import time
import datetime
import re
import queue
from typing import Optional
import flet as ft
import network
from network import get_network_manager
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

try:
    from data_sync_manager import DataSyncManager
except ImportError:
    DataSyncManager = None


class DataSyncUI:
    """Data synchronization user interface"""

    def __init__(self, data_dir: str, config_manager=None):
        """
        Initialize sync UI (ultra-fast, minimal initialization)

        Args:
            data_dir: SillyTavern data directory
            config_manager: Configuration manager instance
        """
        self.data_dir = data_dir
        self.config_manager = config_manager
        self.page: Optional[ft.Page] = None
        self.refresh_timer = None
        self._initialized = False
        self._ui_created = False

        # Lazy initialization - only create when needed
        self.sync_manager = None
        self._controls = {}
        self._init_error = None

        # AsyncTerminal 相关属性
        self.launch_timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

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

        # 首次启动对话框相关属性
        self._first_server_dialog = None
        self._dialog_countdown_timer = None
        self._dialog_countdown = 60  # 60秒倒计时
        self._dialog_countdown_active = False

        # 读取配置文件中的日志设置
        self.enable_logging = True  # 默认启用日志
        try:
            if self.config_manager:
                self.enable_logging = self.config_manager.get("log", True)
        except:
            pass

    def _ensure_manager(self):
        """Ensure sync manager is initialized (lazy loading)"""
        if self.sync_manager is None:
            if DataSyncManager is None:
                raise ImportError("同步模块不可用，请检查依赖安装")
            try:
                self.sync_manager = DataSyncManager(self.data_dir, self.config_manager)
                # Set UI log callback to direct messages to the log control
                self.sync_manager.set_ui_log_callback(self._add_log)
            except Exception as e:
                raise Exception(f"同步管理器初始化失败: {e}")

    def _get_control(self, name: str, factory_func):
        """Get or create UI control (lazy loading)"""
        if name not in self._controls:
            self._controls[name] = factory_func()
        return self._controls[name]

    def _initialize_all_controls(self):
        """Initialize all UI controls at once"""
        try:
            # Ensure sync manager is available
            if self.sync_manager is None:
                self._ensure_manager()

            # Status controls
            self._controls['status_text'] = ft.Text("数据同步", size=24, weight=ft.FontWeight.BOLD)
            self._controls['current_status'] = ft.Text("状态: 就绪", size=14)
            self._controls['server_url_text'] = ft.Text("服务器地址: 未启动", size=12, selectable=True)

            # Create all other control groups
            self._create_server_controls()
            self._create_client_controls()
            self._create_progress_controls()
            self._create_server_list()
            self._create_log_area()

        except ImportError:
            # Fallback controls when dependencies are missing
            self._controls['status_text'] = ft.Text("数据同步", size=24, weight=ft.FontWeight.BOLD)
            self._controls['current_status'] = ft.Text("状态: 缺少依赖", size=14, color=ft.Colors.RED_500)
            self._controls['server_url_text'] = ft.Text("服务器地址: 不可用", size=12, selectable=True)
        except Exception:
            # Fallback controls for other errors
            self._controls['status_text'] = ft.Text("数据同步", size=24, weight=ft.FontWeight.BOLD)
            self._controls['current_status'] = ft.Text("状态: 初始化失败", size=14, color=ft.Colors.RED_500)
            self._controls['server_url_text'] = ft.Text("服务器地址: 不可用", size=12, selectable=True)

    def create_ui(self, page: ft.Page) -> ft.Column:
        """Create the UI layout (fast direct creation)"""
        self.page = page

        # Create all controls immediately
        self._initialize_all_controls()

        # Start refresh timer after UI is created
        self._start_refresh_timer()

        # Initial status update
        self._update_ui()

        # Create full layout directly
        return self._create_full_layout()

    
    def _create_server_controls(self):
        """Create server configuration controls"""
        self._controls['server_switch'] = ft.Switch(
            label="启动同步服务",
            value=False,
            on_change=self._on_server_toggle
        )
        self._controls['port_input'] = ft.TextField(
            label="服务端口",
            value="9999",
            width=100,
            text_align=ft.TextAlign.CENTER
        )
        # 动态获取本机局域网IP作为默认值
        default_host = self._get_default_lan_ip()
        self._controls['host_input'] = ft.TextField(
            label="监听地址 (仅局域网)",
            value=default_host,
            width=200
        )

    def _create_client_controls(self):
        """Create client configuration controls"""
        self._controls['server_url_input'] = ft.TextField(
            label="服务器地址",
            value="http://192.168.1.100:9999",
            width=300,
            hint_text="例如: http://192.168.1.100:9999"
        )
        self._controls['method_dropdown'] = ft.Dropdown(
            label="同步方法",
            options=[
                ft.dropdown.Option("auto", "自动 (优先ZIP)"),
                ft.dropdown.Option("zip", "ZIP全量同步"),
                ft.dropdown.Option("incremental", "增量同步")
            ],
            value="auto",
            width=200
        )
        self._controls['backup_switch'] = ft.Switch(
            label="备份现有数据",
            value=True
        )
        self._controls['scan_button'] = ft.ElevatedButton(
            "扫描服务器",
            on_click=self._scan_servers,
            icon=ft.Icons.SEARCH
        )
        self._controls['sync_button'] = ft.ElevatedButton(
            "开始同步",
            on_click=self._start_sync,
            icon=ft.Icons.SYNC,
            disabled=True
        )

    def _create_progress_controls(self):
        """Create progress and info controls"""
        self._controls['progress_bar'] = ft.ProgressBar(visible=False)
        self._controls['sync_progress'] = ft.Text("", size=12)
        self._controls['data_info_text'] = ft.Text("", size=12)

    def _create_server_list(self):
        """Create server list control"""
        self._controls['server_list'] = ft.ListView(
            height=150,
            spacing=5,
            expand=False
        )

    def _create_log_area(self):
        """Create enhanced log area control with ANSI color support"""
        self._controls['log_area'] = ft.ListView(
            height=200,
            spacing=2,
            padding=5,
            auto_scroll=True
        )

        # 启动异步日志处理循环和日志文件写入线程
        self._start_log_processing_loop()
        self._start_log_file_thread()

    def _create_full_layout(self) -> ft.Column:
        """Create the complete UI layout"""
        return ft.Column(
            [
                # Main title
                ft.Row(
                    [
                        self._controls['status_text'],
                        ft.Container(
                            self._controls['current_status'],
                            margin=ft.margin.only(left=20)
                        ),
                        ft.Container(
                            ft.Text("请仅在信任的网络上使用本功能！", size=18, weight=ft.FontWeight.BOLD,color=ft.Colors.RED_500),
                            margin=ft.margin.only(left=20)
                        ),
                  ],     
                ),
                ft.Divider(),

                # Server configuration
                ft.Column([
                    ft.Text("服务器配置", size=18, weight=ft.FontWeight.BOLD),
                    ft.Row([
                        self._controls['server_switch'],
                        ft.Container(
                            ft.Row([
                                self._controls['host_input'],
                                self._controls['port_input']
                            ]),
                            margin=ft.margin.only(left=20)
                        )
                    ]),
                    self._controls['server_url_text'],
                ]),
                ft.Divider(),

                # Client configuration
                ft.Column([
                    ft.Text("客户端配置", size=18, weight=ft.FontWeight.BOLD),
                    ft.Row([
                        self._controls['server_url_input'],
                        self._controls['scan_button']
                    ]),
                    ft.Row([
                        self._controls['method_dropdown'],
                        self._controls['backup_switch'],
                        self._controls['sync_button']
                    ])
                ]),
                ft.Divider(),

                # Server list
                ft.Column([
                    ft.Text("发现的服务器", size=18, weight=ft.FontWeight.BOLD),
                    self._controls['server_list']
                ]),

                # Progress
                ft.Column([
                    self._controls['progress_bar'],
                    self._controls['sync_progress']
                ]),

                # Data info
                self._controls['data_info_text'],

                # Log area
                ft.Column([
                    ft.Text("日志", size=18, weight=ft.FontWeight.BOLD),
                    ft.Container(
                        self._controls['log_area'],
                        border=ft.border.all(1, ft.Colors.OUTLINE),
                        border_radius=5,
                        padding=10,
                        width=730
                    )
                ])
            ],
            scroll=ft.ScrollMode.AUTO,
            expand=True
        )

    def _start_refresh_timer(self):
        """Start timer to refresh UI (optimized)"""
        if self.refresh_timer:
            self.refresh_timer.cancel()
            self.refresh_timer = None

        def refresh():
            # Check if page is still valid
            if self.page is None:
                return

            # Only update if needed (reduce unnecessary calls)
            try:
                # Cache last sync info to avoid redundant calls
                current_sync_info = None
                if self.sync_manager:
                    current_sync_info = self.sync_manager.get_sync_info()

                # Update UI with cached info
                self._update_ui_with_info(current_sync_info)

                # Schedule next refresh if page is still valid
                if self.page is not None:
                    self.refresh_timer = threading.Timer(5.0, refresh)  # Increased to 5 seconds
                    self.refresh_timer.start()
            except Exception:
                pass  # Ignore errors during refresh

        if self.page is not None:
            self.refresh_timer = threading.Timer(5.0, refresh)  # Initial delay 5 seconds
            self.refresh_timer.start()

    def _update_ui_with_info(self, sync_info=None):
        """Update UI with cached sync info (optimized)"""
        try:
            # Check if page is still valid
            if self.page is None:
                return

            # If no sync info provided, get it (for backward compatibility)
            if sync_info is None:
                if self.sync_manager is None:
                    self._ensure_manager()
                sync_info = self.sync_manager.get_sync_info()

            # Update status (always available)
            status_map = {
                "idle": "就绪",
                "syncing": "同步中...",
                "server": "服务器运行中",
                "error": "错误"
            }
            status_text = status_map.get(sync_info['status'], sync_info['status'])
            self._controls['current_status'].value = f"状态: {status_text}"

            # Update server info (if controls are initialized)
            if 'server_url_text' in self._controls and 'server_switch' in self._controls:
                if sync_info['is_server_running']:
                    self._controls['server_url_text'].value = f"服务器地址: {sync_info['server_url']}"
                    self._controls['server_switch'].value = True
                    if 'sync_button' in self._controls:
                        self._controls['sync_button'].disabled = True  # Can't sync while server is running
                else:
                    self._controls['server_url_text'].value = "服务器地址: 未启动"
                    self._controls['server_switch'].value = False
                    if 'sync_button' in self._controls:
                        self._controls['sync_button'].disabled = False

            # Update progress (if controls are initialized)
            if 'progress_bar' in self._controls and 'sync_progress' in self._controls:
                if sync_info['status'] == 'syncing':
                    self._controls['progress_bar'].visible = True
                    self._controls['sync_progress'].value = "正在同步数据..."
                else:
                    self._controls['progress_bar'].visible = False
                    self._controls['sync_progress'].value = ""

            # Update page safely
            try:
                if self.page:
                    self.page.update()
            except RuntimeError as re:
                if "Event loop is closed" in str(re):
                    # Page is shutting down, clear reference
                    self.page = None
                else:
                    raise

        except Exception:
            pass  # Silently ignore errors in refresh timer

    def _update_ui(self):
        """Update UI with current status (full update)"""
        try:
            # Check if page is still valid
            if self.page is None:
                return

            # Ensure sync manager is initialized
            if self.sync_manager is None:
                self._ensure_manager()

            sync_info = self.sync_manager.get_sync_info()
            data_info = self.sync_manager.get_data_info()

            # Update status (always available)
            status_map = {
                "idle": "就绪",
                "syncing": "同步中...",
                "server": "服务器运行中",
                "error": "错误"
            }
            status_text = status_map.get(sync_info['status'], sync_info['status'])
            self._controls['current_status'].value = f"状态: {status_text}"

            # Update server info (if controls are initialized)
            if 'server_url_text' in self._controls and 'server_switch' in self._controls:
                if sync_info['is_server_running']:
                    self._controls['server_url_text'].value = f"服务器地址: {sync_info['server_url']}"
                    self._controls['server_switch'].value = True
                    if 'sync_button' in self._controls:
                        self._controls['sync_button'].disabled = True  # Can't sync while server is running
                else:
                    self._controls['server_url_text'].value = "服务器地址: 未启动"
                    self._controls['server_switch'].value = False
                    if 'sync_button' in self._controls:
                        self._controls['sync_button'].disabled = False

            # Update data info (if control is initialized)
            if 'data_info_text' in self._controls:
                if data_info['exists']:
                    self._controls['data_info_text'].value = (
                        f"数据目录: {data_info['data_dir']} | "
                        f"文件数量: {data_info['file_count']} | "
                        f"总大小: {data_info['size_formatted']}"
                    )
                else:
                    self._controls['data_info_text'].value = f"数据目录: {data_info['data_dir']} (不存在)"

            # Update progress (if controls are initialized)
            if 'progress_bar' in self._controls and 'sync_progress' in self._controls:
                if sync_info['status'] == 'syncing':
                    self._controls['progress_bar'].visible = True
                    self._controls['sync_progress'].value = "正在同步数据..."
                else:
                    self._controls['progress_bar'].visible = False
                    self._controls['sync_progress'].value = ""

            # Update page safely
            try:
                if self.page:
                    self.page.update()
            except RuntimeError as re:
                if "Event loop is closed" in str(re):
                    # Page is shutting down, clear reference
                    self.page = None
                else:
                    raise

        except Exception as e:
            self._add_log(f"更新UI时出错: {e}")

    def _add_log(self, message: str, level: str = 'info'):
        """
        线程安全的异步日志添加方法
        支持ANSI颜色代码和多种日志级别

        Args:
            message (str): 日志消息
            level (str): 日志级别 ('info', 'success', 'warning', 'error')
        """
        import re
        LOG_MAX_LENGTH = 2000  # 单条日志长度限制

        try:
            # 优先处理空值情况
            if not message:
                return

            # 限制单条日志长度并清理多余换行
            processed_message = message[:LOG_MAX_LENGTH].replace('\r\n', '\n').replace('\r', '\n')

            # 添加到异步处理队列
            log_entry = {
                'timestamp': time.strftime("%H:%M:%S"),
                'full_timestamp': time.strftime("%Y-%m-%d %H:%M:%S"),
                'message': processed_message,
                'level': level.lower()
            }

            self._log_queue.put(log_entry)

        except Exception as e:
            import traceback
            print(f"添加日志时发生未知错误: {str(e)}")
            print(f"错误详情: {traceback.format_exc()}")

    def _add_log_legacy(self, message: str):
        """兼容旧版本的日志添加方法（直接添加到UI，不使用队列）"""
        if self.page is None:
            return  # Don't log if page is being destroyed

        # Check if log area is initialized
        if 'log_area' not in self._controls:
            return  # Log area not yet initialized

        timestamp = time.strftime("%H:%M:%S")
        log_entry = ft.Text(f"[{timestamp}] {message}", size=11)
        self._controls['log_area'].controls.append(log_entry)

        # Keep only last 50 entries
        if len(self._controls['log_area'].controls) > 50:
            self._controls['log_area'].controls = self._controls['log_area'].controls[-50:]

        # Update page safely
        try:
            if self.page:
                self.page.update()
        except RuntimeError as re:
            if "Event loop is closed" in str(re):
                # Page is shutting down, clear reference
                self.page = None
            else:
                raise

    def _on_server_toggle(self, e):
        """Handle server switch toggle"""
        def toggle_server():
            try:
                self._ensure_manager()

                server_switch = self._controls.get('server_switch')
                port_input = self._controls.get('port_input')
                host_input = self._controls.get('host_input')

                if server_switch and server_switch.value:
                    port = int(port_input.value) if port_input and port_input.value.isdigit() else 9999
                    # 优先使用用户输入的地址，如果没有则自动获取局域网IP，确保只在局域网内工作
                    if host_input and host_input.value.strip():
                        host = host_input.value.strip()
                    else:
                        host = self._get_default_lan_ip()

                    # 先检查是否需要显示首次启动对话框
                    should_show = self._should_show_first_server_dialog()

                    if should_show:
                        # 需要显示首次对话框，不启动服务器
                        self._show_first_server_dialog(port, host)  # 传递端口和主机信息
                    else:
                        # 不需要显示对话框，直接启动服务器
                        success = self.sync_manager.start_sync_server(port, host)

                        if success:
                            self._add_log(f"同步服务已启动: {self.sync_manager.get_server_url()}")
                        else:
                            self._add_log("启动同步服务失败")
                            if self.page:
                                self.page.snack_bar = ft.SnackBar(content=ft.Text("启动同步服务失败"), bgcolor=ft.Colors.RED_500)
                                self.page.snack_bar.open = True
                                self.page.update()
                else:
                    success = self.sync_manager.stop_sync_server()
                    if success:
                        self._add_log("同步服务已停止")
                    else:
                        self._add_log("停止同步服务失败")

                self._update_ui()

            except Exception as ex:
                self._add_log(f"切换服务器状态时出错: {ex}")

        # Run in background thread to avoid blocking UI
        threading.Thread(target=toggle_server, daemon=True).start()

    def _should_show_first_server_dialog(self):
        """检查是否应该显示首次启动服务器对话框"""
        try:
            if self.config_manager:
                # 检查是否已经显示过首次启动对话框
                return not self.config_manager.get("sync.first_shown", False)
            return True  # 如果没有配置管理器，默认显示
        except:
            return True  # 出错时默认显示

    def _mark_first_server_dialog_shown(self):
        """标记首次启动对话框已显示"""
        try:
            if self.config_manager:
                self.config_manager.set("sync.first_shown", True)
        except:
            pass  # 出错时忽略

    def _show_first_server_dialog(self, port=None, host=None):
        """显示首次启动服务器的不可关闭对话框"""
        # 倒计时文本
        countdown_text = ft.Text(
            f"请仔细阅读以下内容（{self._dialog_countdown}秒后可关闭）",
            size=16,
            weight=ft.FontWeight.BOLD,
            color=ft.Colors.RED_500
        )

        # 警告内容
        warning_content = ft.Column([
            ft.Text("⚠️ 安全提醒", size=20, weight=ft.FontWeight.BOLD, color=ft.Colors.RED_600),
            ft.Divider(),
            ft.Text(
                "您正在启动 SillyTavern 数据同步服务器，请务必注意以下几点：",
                size=14
            ),
            ft.Text("• 请仅在信任的局域网内使用本功能", size=13, color=ft.Colors.RED_500),
            ft.Text("• 确保您的网络环境安全可靠", size=13, color=ft.Colors.RED_500),
            ft.Text("• 同步数据包含您的聊天记录和各种设置以及密钥！！！", size=13, color=ft.Colors.RED_500),
            ft.Text("• 建议定期备份重要数据", size=13, color=ft.Colors.RED_500),
            ft.Divider(),
            ft.Text(
                "服务器启动后，局域网内的其他设备可以通过您的IP地址和端口访问同步服务。",
                size=13
            ),
            ft.Text(
                f"默认端口: 9999，访问地址格式: http://您的IP:9999",
                size=12,
                color=ft.Colors.GREY_600
            ),
        ], scroll=ft.ScrollMode.AUTO, tight=True)

        # 不再显示按钮状态
        dont_show_state = {"clicked": False}

        def toggle_dont_show(e):
            """切换不再显示状态"""
            dont_show_state["clicked"] = not dont_show_state["clicked"]
            if dont_show_state["clicked"]:
                dont_show_button.text = "已设置不再显示"
                dont_show_button.icon = ft.Icons.CHECK
                dont_show_button.style = ft.ButtonStyle(
                    bgcolor=ft.Colors.GREEN_500,
                    color=ft.Colors.WHITE
                )
            else:
                dont_show_button.text = "不再显示此提醒"
                dont_show_button.icon = ft.Icons.BOOKMARK_REMOVE
                dont_show_button.style = ft.ButtonStyle(
                    bgcolor=ft.Colors.BLUE_500,
                    color=ft.Colors.WHITE
                )
            if self.page:
                self.page.update()

        # 不再显示按钮（与关闭按钮样式一致）
        dont_show_button = ft.ElevatedButton(
            "不再显示此提醒",
            icon=ft.Icons.BOOKMARK_REMOVE,
            style=ft.ButtonStyle(
                bgcolor=ft.Colors.BLUE_500,
                color=ft.Colors.WHITE
            ),
            on_click=toggle_dont_show
        )

        # 关闭按钮（初始禁用）
        close_button = ft.ElevatedButton(
            "关闭",
            icon=ft.Icons.CLOSE,
            disabled=True,
            style=ft.ButtonStyle(
                bgcolor=ft.Colors.RED_500,
                color=ft.Colors.WHITE
            )
        )

        def update_countdown():
            """更新倒计时"""
            if self._dialog_countdown > 0:
                self._dialog_countdown -= 1
                countdown_text.value = f"请仔细阅读以下内容（{self._dialog_countdown}秒后可关闭）"

                # 倒计时结束，启用关闭按钮
                if self._dialog_countdown == 0:
                    close_button.disabled = False
                    countdown_text.value = "您可以关闭此窗口了"
                    countdown_text.color = ft.Colors.GREEN_500

                if self._first_server_dialog and self.page:
                    try:
                        self.page.update()
                    except RuntimeError:
                        # 页面已关闭，停止倒计时
                        self._dialog_countdown_active = False

        def start_countdown():
            """启动倒计时"""
            def countdown_worker():
                while self._dialog_countdown > 0 and self._dialog_countdown_active:
                    time.sleep(1)
                    if self._dialog_countdown_active and self.page:
                        # 调用UI更新，Flet会自动处理线程调度
                        update_countdown()

            self._dialog_countdown_active = True
            self._dialog_countdown = 60  # 重置为60秒
            countdown_thread = threading.Thread(target=countdown_worker, daemon=True)
            countdown_thread.start()

        def on_close(e=None):
            """关闭对话框"""
            # 停止倒计时
            self._dialog_countdown_active = False

            # 如果点击了"不再显示"，保存到配置
            if dont_show_state["clicked"]:
                self._mark_first_server_dialog_shown()

            # 关闭对话框
            if self.page and self._first_server_dialog:
                self._first_server_dialog.open = False
                self.page.update()

            # 关闭对话框后启动服务器
            if port is not None and host is not None:
                # 在后台线程中启动服务器以避免阻塞UI
                def start_server_after_dialog():
                    success = self.sync_manager.start_sync_server(port, host)
                    if success:
                        self._add_log(f"同步服务已启动: {self.sync_manager.get_server_url()}")
                    else:
                        self._add_log("启动同步服务失败")
                        if self.page:
                            self.page.snack_bar = ft.SnackBar(content=ft.Text("启动同步服务失败"), bgcolor=ft.Colors.RED_500)
                            self.page.snack_bar.open = True
                            self.page.update()
                    self._update_ui()

                threading.Thread(target=start_server_after_dialog, daemon=True).start()

        # 创建对话框
        self._first_server_dialog = ft.AlertDialog(
            modal=True,
            title=ft.Row([
                ft.Icon(ft.Icons.WARNING, color=ft.Colors.RED_500),
                ft.Text("启动同步服务器提醒", weight=ft.FontWeight.BOLD)
            ]),
            content=ft.Container(
                content=ft.Column([
                    countdown_text,
                    ft.Container(height=10),
                    warning_content,
                ], scroll=ft.ScrollMode.AUTO, tight=True),
                width=500,
                height=350,
                padding=20
            ),
            actions=[
                dont_show_button,
                close_button,
            ],
            actions_alignment=ft.MainAxisAlignment.END,
            on_dismiss=None  # 禁用ESC键和点击外部关闭
        )

        # 设置按钮事件
        close_button.on_click = on_close

        try:
            # 显示对话框
            self.page.open(self._first_server_dialog) 
            self._first_server_dialog.open = True
            self.page.update()

            # 启动倒计时
            start_countdown()
        except Exception as ex:
            self._add_log(f"显示对话框时出错: {ex}")

    def _scan_servers(self, e):
        """Scan for servers on network"""
        def scan():
            try:
                self._ensure_manager()
                self._add_log("开始扫描局域网服务器...")
                servers = self.sync_manager.detect_network_servers()

                server_list = self._controls.get('server_list')
                if server_list:
                    # Clear existing server list
                    server_list.controls.clear()

                    if servers:
                        for i, (server_url, server_info) in enumerate(servers, 1):
                            data_path = server_info.get('data_path', 'N/A')
                            timestamp = server_info.get('timestamp', 'N/A')

                            server_card = ft.Card(
                                ft.Container(
                                    ft.Column([
                                        ft.Row([
                                            ft.Icon(ft.Icons.DNS, color=ft.Colors.BLUE_500),
                                            ft.Text(f"服务器 {i}", weight=ft.FontWeight.BOLD),
                                            ft.Text(server_url, size=11, color=ft.Colors.BLUE_600)
                                        ]),
                                        ft.Text(f"数据路径: {data_path}", size=11),
                                        ft.Text(f"时间: {timestamp}", size=11, color=ft.Colors.GREY_600),
                                        ft.ElevatedButton(
                                            "使用此服务器",
                                            on_click=lambda _, url=server_url: self._select_server(url),
                                            icon=ft.Icons.CHECK
                                        )
                                    ]),
                                    padding=10
                                )
                            )
                            server_list.controls.append(server_card)

                        self._add_log(f"发现 {len(servers)} 个服务器")
                    else:
                        no_server_text = ft.Text("未发现服务器", italic=True, color=ft.Colors.GREY_600)
                        server_list.controls.append(no_server_text)
                        self._add_log("未发现服务器")

                if self.page:
                    self.page.update()

            except Exception as ex:
                self._add_log(f"扫描服务器时出错: {ex}")

        # Run in background thread
        threading.Thread(target=scan, daemon=True).start()

    def _select_server(self, server_url: str):
        """Select a server from the list"""
        server_url_input = self._controls.get('server_url_input')
        if server_url_input:
            server_url_input.value = server_url
            if self.page:
                self.page.update()
        self._add_log(f"已选择服务器: {server_url}")

    def _start_sync(self, e):
        """Start data synchronization"""
        def sync():
            try:
                self._ensure_manager()

                server_url_input = self._controls.get('server_url_input')
                method_dropdown = self._controls.get('method_dropdown')
                backup_switch = self._controls.get('backup_switch')

                if server_url_input:
                    server_url = server_url_input.value.strip()
                    if not server_url:
                        self._add_log("请输入服务器地址")
                        return

                    method = method_dropdown.value if method_dropdown else "auto"
                    backup = backup_switch.value if backup_switch else True

                    self._add_log(f"开始同步: {server_url}")
                    self._add_log(f"同步方法: {method}, 备份数据: {'是' if backup else '否'}")

                    success = self.sync_manager.sync_from_server(server_url, method, backup)

                    if success:
                        self._add_log("数据同步完成!")
                        if self.page:
                            self.page.snack_bar = ft.SnackBar(content=ft.Text("数据同步完成!"), bgcolor=ft.Colors.GREEN_500)
                            self.page.snack_bar.open = True
                            self.page.update()
                    else:
                        self._add_log("数据同步失败!")
                        if self.page:
                            self.page.snack_bar = ft.SnackBar(content=ft.Text("数据同步失败!"), bgcolor=ft.Colors.RED_500)
                            self.page.snack_bar.open = True
                            self.page.update()

                    self._update_ui()

            except Exception as ex:
                self._add_log(f"同步过程中出错: {ex}")
                if self.page:
                    self.page.snack_bar = ft.SnackBar(content=ft.Text(f"同步失败: {ex}"), bgcolor=ft.Colors.RED_500)
                    self.page.snack_bar.open = True
                    self.page.update()

        # Run in background thread
        threading.Thread(target=sync, daemon=True).start()

    
    def destroy(self):
        """Clean up resources"""
        # Cancel refresh timer
        if self.refresh_timer:
            self.refresh_timer.cancel()
            self.refresh_timer = None

        # Stop dialog countdown
        self._dialog_countdown_active = False

        # Stop async logging system
        self._stop_async_logging()

        # Stop sync server if running
        if self.sync_manager:
            try:
                if hasattr(self.sync_manager, 'is_server_running') and self.sync_manager.is_server_running:
                    self.sync_manager.stop_sync_server()
            except Exception:
                pass  # Ignore errors during cleanup

        # Clear page reference to prevent access during shutdown
        self.page = None
        self._ui_created = False

    def async_initialize(self):
        """Initialize asynchronously (called from main thread)"""
        # This method is called to start async initialization
        # The actual work is done in _initialize_full_ui_async
        pass

    def _get_default_lan_ip(self):
        """
        获取本机局域网IP地址作为UI默认值

        Returns:
            str: 本机局域网IP地址，如果获取失败则返回默认值
        """
        try:
            # 使用network.py中的NetworkManager获取IP
            network_manager = get_network_manager()
            local_ip = network_manager.get_local_ip()

            if local_ip:
                return local_ip
        except Exception:
            pass

        # 如果都失败了，返回一个常见的局域网IP作为默认值
        return "192.168.1.100"

    def _is_valid_lan_ip(self, ip):
        """
        验证是否为有效的局域网IP地址

        Args:
            ip (str): 要验证的IP地址

        Returns:
            bool: 是否为有效的局域网IP地址
        """
        try:
            # 使用network.py中的NetworkManager验证IP
            network_manager = get_network_manager()
            return network_manager._is_valid_lan_ip(ip)
        except Exception:
            return False

    # ================ AsyncTerminal 相关方法 ================

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

    def _process_batch(self):
        """处理批量日志条目"""
        # 阻止并发处理
        if self._processing:
            return

        # 获取当前时间
        current_time = time.time()

        # 检查是否需要处理（基于时间间隔或队列大小）
        queue_size = self._log_queue.qsize()

        # 需要处理的条件：时间间隔到了或队列积压较多
        should_process = (
            (current_time - self._last_process_time >= self._process_interval) or
            (queue_size >= self._batch_size_threshold)
        )

        if not should_process:
            return

        try:
            self._processing = True
            self._last_process_time = current_time

            # 批量处理日志条目
            batch = []
            processed_count = 0

            # 限制单次处理的条目数量
            max_batch_size = min(self._batch_size_threshold * 2, queue_size)

            while processed_count < max_batch_size and not self._log_queue.empty():
                try:
                    entry = self._log_queue.get_nowait()
                    batch.append(entry)
                    processed_count += 1
                except queue.Empty:
                    break

            if batch:
                self._add_log_batch_to_ui(batch)

        except Exception as e:
            print(f"批量处理日志时出错: {str(e)}")
        finally:
            self._processing = False

    def _add_log_batch_to_ui(self, batch):
        """批量添加日志到UI"""
        if self.page is None or 'log_area' not in self._controls:
            return

        try:
            for entry in batch:
                timestamp = entry.get('timestamp', time.strftime("%H:%M:%S"))
                message = entry.get('message', '')
                level = entry.get('level', 'info')

                # 解析 ANSI 颜色代码
                spans = parse_ansi_text(message)

                if spans and len(spans) > 1:  # 有颜色代码
                    try:
                        # Flet Text 支持多个 spans，但是需要不同的格式
                        colored_parts = []
                        for span in spans:
                            if span.style and span.style.color:
                                colored_parts.append(ft.Text(
                                    span.text,
                                    size=11,
                                    color=span.style.color
                                ))
                            else:
                                colored_parts.append(ft.Text(span.text, size=11))

                        # 组合时间戳和彩色文本
                        log_entry = ft.Row([
                            ft.Text(f"[{timestamp}] ", size=11, color=ft.Colors.GREY_600),
                            *colored_parts
                        ], spacing=0, wrap=True)

                    except Exception:
                        # 如果彩色渲染失败，使用普通文本
                        color = self._get_level_color(level)
                        log_entry = ft.Text(
                            f"[{timestamp}] {message}",
                            size=11,
                            color=color
                        )
                else:
                    # 普通文本，使用不同颜色表示不同级别
                    color = self._get_level_color(level)
                    log_entry = ft.Text(
                        f"[{timestamp}] {message}",
                        size=11,
                        color=color
                    )

                self._controls['log_area'].controls.append(log_entry)

                # 同时添加到文件写入队列
                self._log_file_queue.put({
                    'timestamp': entry.get('full_timestamp', time.strftime("%Y-%m-%d %H:%M:%S")),
                    'level': level,
                    'message': message
                })

            # 保持最大日志条目数限制
            if len(self._controls['log_area'].controls) > self._max_log_entries:
                # 保留最后的一半日志
                keep_count = self._max_log_entries // 2
                self._controls['log_area'].controls = self._controls['log_area'].controls[-keep_count:]

            # 更新UI
            if self.page:
                self.page.update()

        except Exception as e:
            print(f"添加日志批量到UI时出错: {str(e)}")

    def _get_level_color(self, level: str):
        """根据日志级别返回对应的颜色"""
        level = level.lower()
        if level == 'error':
            return ft.Colors.RED_500
        elif level == 'warning':
            return ft.Colors.ORANGE_500
        elif level == 'success':
            return ft.Colors.GREEN_500
        elif level == 'info':
            return ft.Colors.BLUE_500
        else:
            return ft.Colors.BLACK

    def _write_log_entries_to_file(self, entries):
        """将一批日志条目写入文件"""
        # 检查是否启用日志输出
        if not self.enable_logging:
            return

        try:
            # 创建logs目录（如果不存在）
            logs_dir = os.path.join(os.getcwd(), "logs")
            os.makedirs(logs_dir, exist_ok=True)

            # 创建日志文件路径
            log_file = os.path.join(logs_dir, f"sync_{self.launch_timestamp}.log")

            # 批量写入日志条目
            with open(log_file, 'a', encoding='utf-8') as f:
                for entry in entries:
                    timestamp = entry.get('timestamp', time.strftime("%Y-%m-%d %H:%M:%S"))
                    level = entry.get('level', 'INFO')
                    message = entry.get('message', '')

                    # 清理 ANSI 代码用于文件日志
                    clean_message = ANSI_ESCAPE_REGEX.sub('', message)

                    log_line = f"[{timestamp}] [{level}] {clean_message}\n"
                    f.write(log_line)

        except Exception as e:
            print(f"写入日志文件失败: {str(e)}")

    def update_log_setting(self, enabled: bool):
        """更新日志设置"""
        self.enable_logging = enabled

    def _stop_async_logging(self):
        """停止异步日志系统"""
        # 设置停止事件
        self._stop_event.set()
        self._log_file_stop_event.set()

        # 等待线程结束
        if hasattr(self, '_log_thread') and self._log_thread.is_alive():
            self._log_thread.join(timeout=2.0)

        if hasattr(self, '_log_file_thread') and self._log_file_thread.is_alive():
            self._log_file_thread.join(timeout=2.0)


def show_sync_dialog(page: ft.Page, data_dir: str, config_manager=None) -> None:
    """Show sync dialog"""
    # Create sync UI
    sync_ui = DataSyncUI(data_dir, config_manager)

    # Create dialog
    dialog = ft.AlertDialog(
        modal=True,
        title=ft.Row([
            ft.Icon(ft.Icons.SYNC, color=ft.Colors.BLUE_500),
            ft.Text("数据同步", weight=ft.FontWeight.BOLD)
        ]),
        content=ft.Container(
            sync_ui.create_ui(page),
            width=800,
            height=600,
            padding=10
        ),
        actions=[
            ft.TextButton(
                "关闭",
                on_click=lambda e: (
                    sync_ui.destroy(),
                    setattr(page.dialog, 'open', False),
                    page.update()
                )
            )
        ],
        actions_alignment=ft.MainAxisAlignment.END
    )

    # Show dialog
    page.dialog = dialog
    dialog.open = True
    page.update()


def show_sync_status(page: ft.Page, data_dir: str, config_manager=None) -> ft.Text:
    """Create a sync status text widget"""
    if DataSyncManager is None:
        return ft.Text("同步: 模块不可用", size=12, color=ft.Colors.RED_500)

    try:
        sync_manager = DataSyncManager(data_dir, config_manager)
        sync_info = sync_manager.get_sync_info()

        status_map = {
            "idle": "就绪",
            "syncing": "同步中...",
            "server": "服务器运行中",
            "error": "错误"
        }

        status_text = status_map.get(sync_info['status'], sync_info['status'])
        return ft.Text(f"同步: {status_text}", size=12)
    except Exception:
        return ft.Text("同步: 初始化失败", size=12, color=ft.Colors.RED_500)