#!/usr/bin/env python3
"""
SillyTavern Data Sync UI
Flet-based user interface for data synchronization
"""

import os
import threading
import time
from typing import Optional
import flet as ft
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

    def _ensure_manager(self):
        """Ensure sync manager is initialized (lazy loading)"""
        if self.sync_manager is None:
            if DataSyncManager is None:
                raise ImportError("同步模块不可用，请检查依赖安装")
            try:
                self.sync_manager = DataSyncManager(self.data_dir, self.config_manager)
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
            self._controls['status_text'] = ft.Text("数据同步", size=20, weight=ft.FontWeight.BOLD)
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
            self._controls['status_text'] = ft.Text("数据同步", size=20, weight=ft.FontWeight.BOLD)
            self._controls['current_status'] = ft.Text("状态: 缺少依赖", size=14, color=ft.Colors.RED_500)
            self._controls['server_url_text'] = ft.Text("服务器地址: 不可用", size=12, selectable=True)
        except Exception:
            # Fallback controls for other errors
            self._controls['status_text'] = ft.Text("数据同步", size=20, weight=ft.FontWeight.BOLD)
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
        self._controls['host_input'] = ft.TextField(
            label="监听地址",
            value="0.0.0.0",
            width=150
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
        """Create log area control"""
        self._controls['log_area'] = ft.Column(
            height=200,
            scroll=ft.ScrollMode.AUTO,
            auto_scroll=True
        )

    def _create_full_layout(self) -> ft.Column:
        """Create the complete UI layout"""
        return ft.Column(
            [
                # Header
                ft.Row(
                    [
                        self._controls['status_text'],
                        ft.Container(
                            self._controls['current_status'],
                            margin=ft.margin.only(left=20)
                        )
                    ],
                ),
                ft.Divider(),

                # Server configuration
                ft.Container(
                    ft.Column([
                        ft.Text("服务器配置", size=16, weight=ft.FontWeight.BOLD),
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
                    margin=ft.margin.symmetric(vertical=10)
                ),
                ft.Divider(),

                # Client configuration
                ft.Container(
                    ft.Column([
                        ft.Text("客户端配置", size=16, weight=ft.FontWeight.BOLD),
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
                    margin=ft.margin.symmetric(vertical=10)
                ),
                ft.Divider(),

                # Server list
                ft.Container(
                    ft.Column([
                        ft.Text("发现的服务器", size=14, weight=ft.FontWeight.BOLD),
                        self._controls['server_list']
                    ]),
                    margin=ft.margin.symmetric(vertical=10)
                ),

                # Progress
                ft.Container(
                    ft.Column([
                        self._controls['progress_bar'],
                        self._controls['sync_progress']
                    ]),
                    margin=ft.margin.symmetric(vertical=10)
                ),

                # Data info
                ft.Container(
                    self._controls['data_info_text'],
                    margin=ft.margin.symmetric(vertical=10)
                ),

                # Log area
                ft.Container(
                    ft.Column([
                        ft.Text("日志", size=14, weight=ft.FontWeight.BOLD),
                        ft.Container(
                            self._controls['log_area'],
                            border=ft.border.all(1, ft.Colors.OUTLINE),
                            border_radius=5,
                            padding=10,
                            width=730
                        )
                    ]),
                    margin=ft.margin.symmetric(vertical=10)
                )
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

    def _add_log(self, message: str):
        """Add message to log area"""
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
                    host = host_input.value if host_input else "0.0.0.0"
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