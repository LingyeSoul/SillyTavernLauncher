import flet as ft
import platform
from env import Env
from sysenv import SysEnv
from stconfig import stcfg
from event import UiEvent
from config import ConfigManager
import os
import subprocess
import datetime
import re

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

class Terminal:
    def __init__(self,page):
        self.logs = ft.ListView(
            expand=True,
            spacing=5,
            auto_scroll=True,
            padding=10
        )
        # 初始化启动时间戳
        self.launch_timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        if page.platform == ft.PagePlatform.WINDOWS:
            self.view = ft.Column([
            ft.Text("终端", size=24, weight=ft.FontWeight.BOLD),
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

    def update_log_setting(self, enabled: bool):
        """更新日志设置"""
        self.enable_logging = enabled

    def stop_processes(self):
        """停止所有由execute_command启动的进程"""
        self.add_log("正在终止所有进程...")
        
        # 首先停止所有输出线程
        for thread in self._output_threads:
            if thread.is_alive():
                thread.join(timeout=1.0)
        
        self._output_threads = []
        env = Env()
        # 使用平台特定方式终止进程
        for proc_info in self.active_processes[:]:  # 使用副本避免遍历时修改
            try:
                process = proc_info['process']
                if process.poll() is None:  # 检查进程是否仍在运行
                    self.add_log(f"终止进程 {proc_info['pid']}: {proc_info['command']}")
                    
                    # 首先使用PowerShell递归终止整个进程树
                    subprocess.run(
                        f"powershell.exe -Command \"Get-CimInstance Win32_Process -Filter 'ParentProcessId={proc_info['pid']}' | Select-Object -ExpandProperty Handle | ForEach-Object {{ Stop-Process -Id $_ -Force }}\"",
                        shell=True,
                        stderr=subprocess.PIPE,
                        creationflags=subprocess.CREATE_NO_WINDOW
                    )
                    
                    # 使用taskkill递归终止进程树
                    subprocess.run(
                        f"taskkill /F /T /PID {proc_info['pid']}",
                        shell=True,
                        stderr=subprocess.PIPE,
                        creationflags=subprocess.CREATE_NO_WINDOW
                    )
                    
                    # 额外使用PowerShell按名称终止node.exe
                    subprocess.run(
                        f"powershell.exe -Command \"Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force\"",
                        shell=True,
                        stderr=subprocess.PIPE,
                        creationflags=subprocess.CREATE_NO_WINDOW
                    )
                    
                    # 等待进程终止
                    try:
                        process.wait(timeout=3.0)
                    except subprocess.TimeoutExpired:
                        self.add_log(f"进程 {proc_info['pid']} 未能及时终止")
            except Exception as ex:
                self.add_log(f"终止进程时出错: {str(ex)}")
        
        # 清空进程列表
        self.active_processes = []
        self.add_log("所有进程已终止")
         # 标记为不再运行
        self.is_running = False

        return True
    
    def add_log(self, text: str):
        """线程安全的日志添加方法"""  
        import re
        LOG_MAX_LENGTH = 1000
        try:
            # 优先处理空值情况
            if not text:
                return
            
            # 预编译正则表达式
            self._empty_line_pattern = re.compile(r'(\r?\n){3,}')
            
            # 限制单条日志长度并清理多余换行
            processed_text = text[:LOG_MAX_LENGTH]
            processed_text = self._empty_line_pattern.sub('\n\n', processed_text.strip())
            
            # 将日志写入文件
            self._write_log_to_file(processed_text)
            
            # 超长日志特殊处理
            if len(processed_text) >= LOG_MAX_LENGTH:
                self.logs.controls.clear()
            
            # 检查是否包含ANSI颜色代码
            if ANSI_ESCAPE_REGEX.search(processed_text):
                # 解析ANSI颜色代码并创建富文本
                spans = parse_ansi_text(processed_text)
                new_text = ft.Text(spans=spans, selectable=True)
            else:
                # 普通文本
                new_text = ft.Text(processed_text, selectable=True)
            
            async def update_ui():
                try:
                    self.logs.controls.append(new_text)
                    # 更严格的日志数量限制
                    MAX_LOG_ENTRIES = 800
                    if len(self.logs.controls) > MAX_LOG_ENTRIES:
                        self.logs.controls = self.logs.controls[-int(MAX_LOG_ENTRIES/2):]
                    self.logs.scroll_to(offset=float("inf"), duration=100)
                    self.logs.update()
                except Exception as ui_error:
                    print(f"UI更新失败: {str(ui_error)}")

            # 确保在主线程中更新UI
            if hasattr(self, 'view') and self.view.page is not None:
                self.view.page.run_task(update_ui)
        except (TypeError, IndexError, AttributeError) as e:
            print(f"日志处理异常: {str(e)}")
        except Exception as e:
            print(f"未知错误: {str(e)}")
    
    def _write_log_to_file(self, text: str):
        """将日志写入文件"""
        # 检查是否启用日志输出
        if self.enable_logging:
            try:
                # 创建logs目录（如果不存在）
                logs_dir = os.path.join(os.getcwd(), "logs")
                os.makedirs(logs_dir, exist_ok=True)
                
                # 生成基于启动时间戳的文件名
                log_file_path = os.path.join(logs_dir, f"{self.launch_timestamp}.log")
                
                # 获取当前时间戳
                timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                
                # 移除ANSI颜色代码
                clean_text = re.sub(r'\x1b\[[0-9;]*m', '', text)
                
                # 写入日志文件，追加模式
                with open(log_file_path, "a", encoding="utf-8") as log_file:
                    log_file.write(f"[{timestamp}] {clean_text}\n")
            except Exception as e:
                # 如果写入日志文件失败，不中断主流程，只在控制台输出错误
                print(f"写入日志文件失败: {str(e)}")

class UniUI():
    def __init__(self,page,ver,version_checker):
        self.page = page
        self.env = Env()
        self.version_checker = version_checker
        self.version = ver
        self.sysenv = SysEnv()
        self.stcfg = stcfg()
        self.platform = platform.system()
        self.terminal = Terminal(page)
        self.config_manager = ConfigManager()
        self.config = self.config_manager.config
        self.ui_event = UiEvent(self.page, self.terminal)
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
                            ft.dropdown.Option("gh.llkk.cc", "镜像站点1 (gh.llkk.cc)"),
                            ft.dropdown.Option("ghfile.geekertao.top", "镜像站点2 (ghfile.geekertao.top)"),
                            ft.dropdown.Option("gh.dpik.top", "镜像站点3 (gh.dpik.top)"),
                            ft.dropdown.Option("github.dpik.top", "镜像站点4 (github.dpik.top)"),
                            ft.dropdown.Option("github.acmsz.top", "镜像站点5 (github.acmsz.top)"),
                            ft.dropdown.Option("git.yylx.win", "镜像站点6 (git.yylx.win)"),
                        ],
                        value=self.config_manager.get("github.mirror"),
                        on_change=self.ui_event.update_mirror_setting
                    ),
                    ft.Text("切换后新任务将立即生效，特别感谢Github镜像提供者", size=14, color=ft.Colors.BLUE_400),
                    ft.Divider(),
                    ft.Text("环境设置", size=18, weight=ft.FontWeight.BOLD),
                    ft.Text("懒人包请勿修改，如需修改则重启后生效", size=14, color=ft.Colors.GREY_600),
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
                    ft.Text("懒人包请勿修改，如需修改则重启后生效 | 开启后修改系统环境的Git配置文件", size=14, color=ft.Colors.BLUE_400),
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
                        label="启用请求代理",
                        value=self.stcfg.proxy_enabled,
                        on_change=self.ui_event.proxy_changed,
                    ),
                    ft.Text("开启后酒馆的请求会走下方填入的代理", size=14, color=ft.Colors.BLUE_400),
                    ft.Row([
                        self.proxy_url_field,
                        ft.IconButton(
                            icon=ft.Icons.SAVE,
                            tooltip="保存代理设置",
                            on_click=lambda e: self.ui_event.save_proxy_url(self.proxy_url_field.value)
                        )
                    ]),
                    ft.Text("请填入有效的代理URL，支持http, https, socks, socks5, socks4, pac", size=14, color=ft.Colors.BLUE_400),
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
            update_thread = threading.Thread(target=self.version_checker.run_check())
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
            settings_view = self.getSettingView()
            about_view = self.getAboutView()
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
            on_change=lambda e: switch_view(e.control.selected_index)
        )
            terminal_view=self.getTerminalView()
            content = ft.Column(terminal_view, expand=True)
            def switch_view(index):
                content.controls.clear()
                if index == 0:
                    content.controls.extend(terminal_view)
                elif index == 1:
                    content.controls.append(settings_view)
                else:
                    content.controls.append(about_view)
                page.update()
            page.add(
            ft.Row(
                [   
                    rail,
                    ft.VerticalDivider(width=1),
                    content
                ],
                expand=True,  # 确保Row扩展填充可用空间
                alignment=ft.MainAxisAlignment.SPACE_BETWEEN,  # 更好的对齐方式
                vertical_alignment=ft.CrossAxisAlignment.STRETCH  # 垂直方向拉伸
            )
        )
        
    # 设置主题图标
        if not self.config_manager.get("theme") == "light":
            themeIcon=ft.Icons.SUNNY
        else:
            themeIcon=ft.Icons.MODE_NIGHT        
        def minisize(e):
            page.window.minimized = True
            page.update()
        page.theme_mode = self.config_manager.get("theme")
        page.appbar = ft.AppBar(
        #leading=ft.Icon(ft.Icons.PALETTE),
        leading_width=40,
        title=ft.WindowDragArea(content=ft.Text("SillyTavernLauncher"), width=800),
        center_title=False,
        bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
        actions=[
            ft.IconButton(ft.Icons.MINIMIZE,on_click=minisize,icon_size=30),
            ft.IconButton(icon=themeIcon,on_click=self.ui_event.switch_theme,icon_size=30),
            ft.IconButton(ft.Icons.CANCEL_OUTLINED,on_click=self.ui_event.exit_app,icon_size=30),
        ],
    )
        def window_event(e):
            if e.data == "close":
                self.ui_event.exit_app(e)
        page.window.prevent_close = True
        page.window.on_event = window_event