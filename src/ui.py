import flet as ft
import platform
import os
import threading
from env import Env
from sysenv import SysEnv
from stconfig import stcfg
from event import UiEvent
from config import ConfigManager
from terminal import AsyncTerminal


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
                    icon=ft.Icons.HISTORY,
                    selected_icon=ft.Icons.HISTORY,
                    label="版本"
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
                alignment=ft.alignment.Alignment(0, 0)
            )
            self._content.controls.append(loading_content)
            self._page.update()
            return

        # 正常切换视图
        self._content.controls.clear()
        if index == 0:
            # 修复：每次切换到终端视图时重新获取视图，确保按钮事件有效
            terminal_view = self.getTerminalView()
            self._content.controls.extend(terminal_view)
        elif index == 1 and hasattr(self, 'version_view'):
            self._content.controls.append(self.version_view)
        elif index == 2 and hasattr(self, 'sync_view'):
            self._content.controls.append(self.sync_view)
        elif index == 3 and hasattr(self, 'settings_view'):
            self._content.controls.append(self.settings_view)
        elif index == 4 and hasattr(self, 'about_view'):
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

            # 延迟创建版本切换视图
            try:
                from st_version_ui import create_version_switch_view
                self.version_view = create_version_switch_view(page, self.terminal, self.ui_event)
            except Exception as e:
                print(f"版本切换视图初始化失败: {e}")
                # 创建简化版本
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
                        alignment=ft.alignment.Alignment(0, 0)
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