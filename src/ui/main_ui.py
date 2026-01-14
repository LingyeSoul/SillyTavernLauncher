from utils.logger import app_logger
import flet as ft
from flet import UrlLauncher
import platform
import os
import threading
import weakref
from features.system.env import Env
from features.system.env_sys import SysEnv
from features.st.config import stcfg
from core.event import UiEvent
from config.config_manager import ConfigManager
from core.terminal import AsyncTerminal


class UniUI():
    def __init__(self,page,ver,version_checker):
        self.page = page
        self.env = Env()
        self.version_checker = version_checker
        self.version = ver
        self.sysenv = SysEnv()
        self.stcfg = stcfg()
        self.platform = platform.system()
        self.config_manager = ConfigManager()
        self.config = self.config_manager.config
        # 从配置中读取日志开关，默认关闭
        enable_logging = self.config_manager.get("log", False)
        self.terminal = AsyncTerminal(page, enable_logging=enable_logging)
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
                    ft.Text("酒馆设置", size=18, weight=ft.FontWeight.BOLD),
                    ft.Text("调整酒馆设置，重启酒馆生效", size=14, color=ft.Colors.GREY_600),
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
                    ft.Switch(
                        label="使用优化参数",
                        value=self.config_manager.get("use_optimize_args", False),
                        on_change=self.ui_event.optimize_args_changed,
                    ),
                    ft.Text("开启后将在启动命令中添加 --max-old-space-size=4096 参数（在自定义启动参数前）", size=14, color=ft.Colors.BLUE_400),
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
                            ft.Button(
                                "检查系统环境",
                                icon=ft.Icons.SETTINGS,
                                style=self.BSytle,
                                on_click=self.ui_event.sys_env_check,
                                height=40
                            ),
                            ft.Button(
                                "检查内置环境",
                                icon=ft.Icons.SETTINGS,
                                style=self.BSytle,
                                on_click=self.ui_event.in_env_check,
                                height=40
                            ),
                            ft.Button(
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
            # 修复：创建固定的终端页面布局，按钮行固定在底部
            # 这样终端视图可以更换，但按钮行保持不动
            if not hasattr(self, '_terminal_page_container'):
                # 创建按钮行（只创建一次）
                self._terminal_button_row = ft.Row(
                    [
                        ft.Button(
                            "安装",
                            icon=ft.Icons.DOWNLOAD,
                            tooltip="从仓库拉取最新版本并安装依赖",
                            style=self.BSytle,
                            on_click=self.ui_event.install_sillytavern,
                            height=50,
                        ),
                        ft.Button(
                            "启动",
                            icon=ft.Icons.PLAY_ARROW,
                            tooltip="启动SillyTavern",
                            style=self.BSytle,
                            on_click=self.ui_event.check_and_start_sillytavern if self.config_manager.get('stcheckupdate', True) else self.ui_event.start_sillytavern,
                            height=50,
                        ),
                        ft.Button(
                            "停止",
                            icon=ft.Icons.CANCEL,
                            tooltip="停止SillyTavern",
                            style=self.BSytle,
                            on_click=self.ui_event.stop_sillytavern,
                            height=50,
                        ),
                        ft.Button(
                            "更新",
                            icon=ft.Icons.UPDATE,
                            tooltip="更新到最新版本并更新依赖",
                            style=self.BSytle,
                            on_click=self.ui_event.update_sillytavern,
                            height=50,
                        ),
                        ft.Button(
                            "清空",
                            icon=ft.Icons.CLEAR,
                            tooltip="清空终端日志",
                            style=self.BSytle,
                            on_click=self.ui_event.clear_terminal,
                            height=50,
                        ),
                    ],
                    alignment=ft.MainAxisAlignment.CENTER,
                )

                # 创建固定的终端页面容器
                # 结构：上方是终端视图（可更换），下方是按钮行（固定）
                self._terminal_page_container = ft.Column(
                    [
                        self.terminal.view,  # 终端视图在上方
                        ft.Divider(height=20, color=ft.Colors.TRANSPARENT),  # 间距
                        self._terminal_button_row,  # 按钮行固定在下方
                    ],
                    expand=True,
                    spacing=0,
                )

            return self._terminal_page_container
        


    def getAboutView(self):
        # 创建版本检查函数
        def check_for_updates(e):
            import threading
            # 使用同步方法进行更新检查
            update_thread = threading.Thread(target=self.version_checker.run_check_sync)
            update_thread.daemon = True
            update_thread.start()

        # 创建URL打开函数
        async def open_github(e):
            await UrlLauncher().launch_url("https://github.com/LingyeSoul/SillyTavernLauncher")

        async def open_website(e):
            await UrlLauncher().launch_url("https://sillytavern.lingyesoul.top")

        async def open_bilibili(e):
            await UrlLauncher().launch_url("https://space.bilibili.com/298721157")

        async def open_tutorial(e):
            await UrlLauncher().launch_url("https://www.yuque.com/yinsa-0wzmf/rcv7g3?")

        async def open_donation(e):
            await UrlLauncher().launch_url("https://ifdian.net/order/create?user_id=8a03ea64ebc211ebad0e52540025c377")

        if self.platform == "Windows":
            return ft.Column([
        ft.Text("关于", size=24, weight=ft.FontWeight.BOLD),
        ft.Divider(),
        ft.Text("SillyTavernLauncher", size=20, weight=ft.FontWeight.BOLD),
        ft.Text(value=f"版本: {self.version}", size=16),
        ft.Text("作者: 泠夜Soul", size=16),
        ft.Button(
            "访问GitHub仓库",
            icon=ft.Icons.OPEN_IN_BROWSER,
            on_click=open_github,
            style=self.BSytle,
            height=40
        ),
        ft.Button(
            "访问启动器官网",
            icon=ft.Icons.OPEN_IN_BROWSER,
            on_click=open_website,
            style=self.BSytle,
            height=40
        ),
        ft.Button(
            "访问作者B站",
            icon=ft.Icons.OPEN_IN_BROWSER,
            on_click=open_bilibili,
            style=self.BSytle,
            height=40
        ),
        ft.Button(
            "酒馆入门教程",
            icon=ft.Icons.BOOK_ROUNDED,
            on_click=open_tutorial,
            style=self.BSytle,
            height=40
        ),
        ft.Button(
            "打赏作者",
            icon=ft.Icons.ATTACH_MONEY,
            on_click=open_donation,
            style=self.BSytle,
            height=40
        ),
        ft.Button(
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
                    app_logger.error("错误详情: {traceback.format_exc()}")
            except Exception as e:
                import traceback
                print(f"最小化窗口失败: {str(e)}")
                app_logger.error("错误详情: {traceback.format_exc()}")

        # 设置窗口事件
        def window_event(e):
            if e.data == "close":
                # 检查是否启用了托盘功能且托盘还在运行
                use_tray = self.config_manager.get("tray", True)
                tray_exists = hasattr(self.ui_event, 'tray') and self.ui_event.tray is not None

                if use_tray and tray_exists:
                    # 启用托盘且托盘存在时，只隐藏窗口
                    page.window.visible = False
                    page.update()
                else:
                    # 未启用托盘或托盘已被停止时的退出流程：
                    # 1. 先隐藏窗口（立即响应）
                    page.window.visible = False
                    page.window.prevent_close = False
                    try:
                        page.update()
                    except (AssertionError, AttributeError):
                        pass

                    # 2. 再执行清理和退出（同步执行）
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

        # 创建导航栏 - 基于Flet最佳实践重构
        # 使用弱引用避免循环引用导致的内存泄漏
        weak_self = weakref.ref(self)

        def _on_rail_change(e):
            """NavigationRail 变更事件处理器 - 使用弱引用"""
            self_ref = weak_self()
            if self_ref is None:
                # UniUI 对象已被销毁，不再处理事件
                return
            self_ref._handle_view_change(e.control.selected_index)

        rail = ft.NavigationRail(
            selected_index=0,
            label_type=ft.NavigationRailLabelType.ALL,
            # 修复: min_width最小值为56（紧凑模式），默认为72
            min_width=72,
            # 修复: min_extended_width应该比min_width大，默认为256
            min_extended_width=200,
            extended=False,
            # 添加分组对齐控制：-1.0=顶部对齐，0.0=居中，1.0=底部对齐
            group_alignment=-0.9,
            # 启用选中指示器
            use_indicator=True,
            destinations=[
                ft.NavigationRailDestination(
                    # 改进: 为选中/未选中状态使用不同的图标样式
                    icon=ft.Icons.TERMINAL_OUTLINED,
                    selected_icon=ft.Icons.TERMINAL,
                    label="终端"
                ),
                ft.NavigationRailDestination(
                    icon=ft.Icons.HISTORY_TOGGLE_OFF_OUTLINED,
                    selected_icon=ft.Icons.HISTORY,
                    label="版本"
                ),
                ft.NavigationRailDestination(
                    icon=ft.Icons.SYNC_DISABLED,
                    selected_icon=ft.Icons.SYNC,
                    label="同步"
                ),
                ft.NavigationRailDestination(
                    icon=ft.Icons.SETTINGS_OUTLINED,
                    selected_icon=ft.Icons.SETTINGS,
                    label="设置"
                ),
                ft.NavigationRailDestination(
                    icon=ft.Icons.INFO_OUTLINE,
                    selected_icon=ft.Icons.INFO,
                    label="关于"
                ),
            ],
            on_change=_on_rail_change
        )

        # 初始只显示终端视图
        # 参考 ui2.py 模式：使用 Container.content 而不是 Column.controls
        # getTerminalView() 现在返回固定的终端页面容器
        terminal_page = self.getTerminalView()
        content = ft.Container(content=terminal_page, expand=True)

        # 存储引用供异步加载使用
        self._page = page
        self._rail = rail
        self._content = content
        self._terminal_page = terminal_page  # 存储终端页面容器的引用
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

        # 修复：标记页面已就绪，确保终端可以安全更新 UI
        # 这必须在 page.add() 之后调用，因为此时控件才被添加到页面树
        if hasattr(self, 'terminal'):
            self.terminal.set_page_ready(True)

    # 视图映射表 - 遵循 Flet NavigationRail 最佳实践
    # 将索引映射到视图属性和显示名称
    _VIEW_MAP = {
        0: ('_terminal_page', '终端'),
        1: ('version_view', '版本'),
        2: ('sync_view', '同步'),
        3: ('settings_view', '设置'),
        4: ('about_view', '关于'),
    }

    def _handle_view_change(self, index):
        """处理视图切换 - 基于 Flet NavigationRail 最佳实践重构

        Args:
            index: NavigationRail selected_index，表示选中的目标索引
        """
        # 参数验证
        if not isinstance(index, int) or index < 0 or index >= len(self._VIEW_MAP):
            print(f"[UniUI] 无效的视图索引: {index}")
            return

        # 检查视图是否已加载完成
        if not self._are_views_ready():
            self._show_loading_indicator()
            return

        # 获取并显示目标视图
        view = self._get_view_by_index(index)
        if view is not None:
            self._display_view(view)
        else:
            self._show_unavailable_view(index)

    def _are_views_ready(self):
        """检查所有视图是否已加载完成"""
        return hasattr(self, '_views_loaded') and self._views_loaded

    def _show_loading_indicator(self):
        """显示加载指示器 """
        loading_view = ft.Container(
            content=ft.Column([
                ft.Text("正在加载...", size=16, weight=ft.FontWeight.BOLD),
                ft.ProgressBar(visible=True, width=200)
            ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=10),
            height=400,
            alignment=ft.alignment.Alignment(0, 0)
        )
        self._content.content = loading_view
        self._page.update()

    def _get_view_by_index(self, index):
        """根据索引获取视图控件

        Args:
            index: 视图索引

        Returns:
            Control: 视图控件，如果视图不可用则返回 None
        """
        if index == 0:
            # 终端视图特殊处理 - 动态获取
            return self.getTerminalView()

        # 其他视图从映射表获取
        attr_name, _ = self._VIEW_MAP.get(index, (None, None))
        if attr_name and hasattr(self, attr_name):
            return getattr(self, attr_name)

        return None

    def _display_view(self, view):
        """显示指定视图 

        直接替换 content_area.content，无需使用 controls.clear()/append()

        Args:
            view: 要显示的视图控件
        """
        self._content.content = view
        self._page.update()

    def _show_unavailable_view(self, index):
        """显示视图不可用提示 

        Args:
            index: 视图索引
        """
        _, view_name = self._VIEW_MAP.get(index, ('', '未知'))
        unavailable_view = ft.Container(
            content=ft.Column([
                ft.Icon(ft.Icons.ERROR_OUTLINE, size=48, color=ft.Colors.ORANGE),
                ft.Text(f"{view_name}视图不可用", size=16, weight=ft.FontWeight.BOLD),
                ft.Text("请稍后重试", size=13, color=ft.Colors.GREY_600)
            ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=10),
            height=400,
            alignment=ft.alignment.Alignment(0, 0)
        )
        self._content.content = unavailable_view
        self._page.update()

    def _load_views_async(self, page):
        """异步加载复杂视图 - 主题和Appbar已优先加载，此处跳过"""
        try:
            # 延迟创建同步管理器 - 带错误处理
            try:
                from ui.components.sync_ui import DataSyncUI
                import os
                data_dir = os.path.join(os.getcwd(), "SillyTavern", "data", "default-user")
                # 不传入 terminal，使用独立的简单日志组件
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

            # 延迟创建版本切换视图
            try:
                # 检查页面是否仍然有效
                if not self.is_page_valid():
                    app_logger.warning("版本切换视图初始化跳过: 页面已销毁")
                    self.version_view = self._create_simple_version_view()
                else:
                    from features.st.ui.version_ui import create_version_switch_view
                    self.version_view = create_version_switch_view(page, self.terminal, self.ui_event)
            except Exception as e:
                error_msg = str(e)
                # 如果是页面已销毁的错误，静默处理
                if "destroyed" in error_msg.lower() or "session" in error_msg.lower():
                    app_logger.warning("版本切换视图初始化跳过: {error_msg}")
                    self.version_view = self._create_simple_version_view()
                else:
                    print(f"版本切换视图初始化失败: {e}")
                    self.version_view = ft.Column([
                        ft.Text("版本管理", size=24, weight=ft.FontWeight.BOLD),
                        ft.Divider(),
                        ft.Text("版本切换功能初始化失败", color=ft.Colors.RED),
                        ft.Text(f"错误: {str(e)}", size=12, color=ft.Colors.GREY_600)
                    ], spacing=15)

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
                    error_content = ft.Container(
                        content=ft.Column([
                            ft.Text("加载部分界面失败", size=16, color=ft.Colors.RED_500),
                            ft.Text(str(e), size=14),
                            ft.Text("请重启应用或联系开发者", size=14),
                            ft.Button(
                                "重试",
                                on_click=lambda _: threading.Thread(
                                    target=self._load_views_async,
                                    args=(page,),
                                    daemon=True
                                ).start()
                            )
                        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER),
                        height=400,
                        alignment=ft.alignment.Alignment(0, 0)
                    )
                    self._content.content = error_content
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

    def _create_simple_version_view(self):
        """Create a simplified version view when page is destroyed"""
        return ft.Column([
            ft.Text("版本管理", size=24, weight=ft.FontWeight.BOLD),
            ft.Divider(),
            ft.Text("版本管理功能", size=14, color=ft.Colors.GREY_600),
        ], scroll=ft.ScrollMode.AUTO, expand=True, spacing=15)

    def is_page_valid(self):
        """检查页面引用是否仍然有效"""
        if self.page is None:
            return False
        # 检查页面是否已被销毁
        if hasattr(self.page, 'window') and self.page.window is None:
            return False
        return True

    def safe_update_page(self):
        """安全地更新页面"""
        if not self.is_page_valid():
            print("[UniUI] 尝试更新已销毁的页面")
            return False

        try:
            self.page.update()
            return True
        except RuntimeError as e:
            if "Event loop is closed" in str(e) or "window is closed" in str(e):
                print(f"[UniUI] 页面已关闭: {e}")
                self.page = None
                return False
            # 其他 RuntimeError 重新抛出
            raise

    def cleanup(self):
        """清理所有资源，防止内存泄漏

        使用弱引用和显式断开连接来避免循环引用
        """
        try:
            print("[UniUI] 开始清理资源...")

            # 1. 显式断开 NavigationRail 的事件处理器（防止循环引用）
            if hasattr(self, '_rail') and self._rail is not None:
                try:
                    self._rail.on_change = None
                except Exception:
                    pass
                self._rail = None

            # 2. 显式断开按钮行的事件处理器
            if hasattr(self, '_terminal_button_row') and self._terminal_button_row is not None:
                try:
                    for control in self._terminal_button_row.controls[:]:
                        if hasattr(control, 'on_click'):
                            control.on_click = None
                except Exception:
                    pass
                self._terminal_button_row = None

            # 3. 清理 ui_event（必须先清理，打破循环引用）
            if hasattr(self, 'ui_event') and self.ui_event is not None:
                try:
                    if hasattr(self.ui_event, 'cleanup'):
                        self.ui_event.cleanup()
                except Exception:
                    pass
                self.ui_event = None

            # 4. 清理 terminal（添加异常处理，避免解释器关闭时的线程错误）
            if hasattr(self, 'terminal') and self.terminal is not None:
                try:
                    self.terminal.cleanup_all_resources(aggressive=True)
                    self.terminal.stop_periodic_cleanup()
                except RuntimeError as e:
                    if "can't create new thread" not in str(e):
                        raise
                except Exception:
                    pass
                self.terminal = None

            # 5. 清理 sync_ui
            if hasattr(self, 'sync_ui') and self.sync_ui is not None:
                try:
                    self.sync_ui.destroy()
                except Exception:
                    pass
                self.sync_ui = None

            # 6. 清理 content 和 page 引用
            if hasattr(self, '_content') and self._content is not None:
                try:
                    self._content.content = None
                except Exception:
                    pass
                self._content = None

            if hasattr(self, 'page') and self.page is not None:
                try:
                    # 尝试清理 Flet 页面上的所有控件
                    if hasattr(self.page, 'clean'):
                        self.page.clean()
                except Exception:
                    pass
                self.page = None

            # 7. 清理视图引用
            self._views_loaded = False
            if hasattr(self, '_terminal_page'):
                self._terminal_page = None
            if hasattr(self, '_terminal_page_container'):
                self._terminal_page_container = None
            if hasattr(self, 'version_view'):
                self.version_view = None
            if hasattr(self, 'sync_view'):
                self.sync_view = None
            if hasattr(self, 'settings_view'):
                self.settings_view = None
            if hasattr(self, 'about_view'):
                self.about_view = None

            # 8. 强制垃圾回收
            import gc
            gc.collect()

            print("[UniUI] 资源清理完成")
        except RuntimeError as e:
            # 解释器关闭时的线程创建错误是正常的，静默处理
            if "can't create new thread" not in str(e):
                print(f"[UniUI] 清理时出错: {e}")
        except Exception as e:
            print(f"[UniUI] 清理时出错: {e}")

    def __del__(self):
        """析构函数 - 确保资源释放"""
        try:
            self.cleanup()
        except Exception:
            pass    