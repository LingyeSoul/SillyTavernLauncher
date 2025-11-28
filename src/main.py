import flet as ft
from time import sleep
from ui import UniUI
from config import ConfigManager
from update import VersionChecker
import asyncio
import urllib.request
from version import VERSION
from sysenv import SysEnv

async def main(page: ft.Page):
    page.window.center()
    page.title = "SillyTavernLauncher"
    page.theme = ft.Theme(color_scheme_seed=ft.Colors.BLUE,font_family="Microsoft YaHei")
    page.dark_theme=ft.Theme(color_scheme_seed=ft.Colors.BLUE,font_family="Microsoft YaHei")
    page.window.width = 800
    page.window.height = 644
    page.window.resizable = False
    page.window.min_height=644
    page.window.min_width=800
    page.window.maximizable = False
    page.window.title_bar_hidden = True
    version=VERSION
    # 检查是否为首次启动
    async def check_first_launch():
        config_manager = ConfigManager()
        config = config_manager.config
        
        # 检查first_run参数是否存在且为True
        if config.get("first_run", True):
            # 显示欢迎对话框
            show_welcome_dialog()
            # 更新配置文件，将first_run设置为False
            config_manager.set("first_run", False)
            config_manager.save_config()
    
    # 显示欢迎对话框
    def show_welcome_dialog():
        welcome_dialog = ft.AlertDialog(
            title=ft.Text("欢迎使用 SillyTavernLauncher"),
            modal=True,
            content=ft.Column([
                ft.Divider(),
                ft.Text("欢迎使用 SillyTavern 启动器！", size=16, weight=ft.FontWeight.BOLD),
                ft.Text("这是您第一次运行本启动器，以下是基本使用说明：", size=14),
                ft.Text("1. 请先点击'安装'按钮安装 SillyTavern（懒人包请跳过这步）", size=14),
                ft.Text("2. 安装完成后点击'启动'按钮启动酒馆", size=14),
                ft.Text("3. 启动后可通过'停止'按钮停止酒馆", size=14),
                ft.Text("4. 可在'设置'页面配置各种选项", size=14),
                ft.Text("5. 不要使用中文和空格路径存放启动器！", size=14),
                ft.Text("如有任何问题，请查看'关于'页面获取更多信息", size=14),
                ft.Text("祝您使用愉快！", size=14, weight=ft.FontWeight.BOLD),
                ft.Divider(),
            ], width=400, height=300),
            actions=[
                ft.TextButton("酒馆入门教程", on_click=lambda e: e.page.launch_url("https://www.yuque.com/yinsa-0wzmf/rcv7g3?", web_window_name="sillytaverntutorial")),
                ft.TextButton("启动器官网", on_click=lambda e: e.page.launch_url("https://sillytavern.lingyesoul.top", web_window_name="sillytavernlanuncher")),
                ft.TextButton("我已知晓", on_click=lambda e: page.close(welcome_dialog))
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )
        page.open(welcome_dialog)

    # 显示系统环境缺失对话框
    def show_system_env_missing_dialog(missing_items):
        def close_dialog(e):
            page.close(dialog)
            # 关闭整个应用程序
            page.window.visible = False
            page.window.prevent_close = False
            page.update()
            page.window.close()
            
        def open_git_download(e):
            page.launch_url("https://git-scm.com/install/windows")
            
        def open_nodejs_download(e):
            page.launch_url("https://nodejs.org/zh-cn/download")
            
        def open_launcher_download(e):
            page.launch_url("https://sillytavern.lingyesoul.top/update.html")

        dialog = ft.AlertDialog(
            title=ft.Text("系统环境检查失败"),
            modal=True,
            content=ft.Column([
                ft.Text("检测到您正在使用系统环境模式，但以下必需组件缺失或版本不满足要求:", size=14, color=ft.Colors.RED),
                ft.Text(missing_items, size=14),
                ft.Divider(),
                ft.Text("请安装所需的组件后再运行本程序:", size=14),
                ft.Text("1. Git", size=14),
                ft.Text("2. Node.js 18.x 或更高版本", size=14),
                ft.Divider(),
                ft.Text("注意：安装完成后需要重启启动器才能生效，不会安装请前往启动器官网重新下载懒人包", size=14, weight=ft.FontWeight.BOLD),
            ], width=400, height=250),
            actions=[
                ft.TextButton("下载Git", on_click=open_git_download),
                ft.TextButton("下载Node.js", on_click=open_nodejs_download),
                ft.TextButton("下载懒人包", on_click=open_launcher_download),
                ft.TextButton("关闭程序", on_click=close_dialog)
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )
        page.open(dialog)
    # 检查系统环境
    def check_system_environment():
        config_manager = ConfigManager()
        # 检查是否使用系统环境
        if config_manager.get("use_sys_env", False):
            sys_env = SysEnv()
            env_check_result = sys_env.checkSysEnv()
            if env_check_result is not True:
                # 显示系统环境缺失对话框
                show_system_env_missing_dialog(env_check_result)
                return False
        return True

    # 检查更新
    version_checker = VersionChecker(page)
    async def check_for_updates():
        """检查更新并在有新版本时提示用户"""
        # 直接执行检查更新操作
        await asyncio.sleep(1)
        await version_checker.run_check()
    
    #BSytle=ft.ButtonStyle(icon_size=25,text_style=ft.TextStyle(size=20,font_family="Microsoft YaHei"))

    uniUI=UniUI(page,version,version_checker)
    uniUI.setMainView(page)
    # 检查自动代理设置
    config_manager = ConfigManager()
    if config_manager.get("auto_proxy", False):
        # 如果启用了自动代理设置，则自动检测并设置代理
        try:
            proxies = urllib.request.getproxies()
            if proxies:
                # 查找HTTP或SOCKS代理
                proxy_url = ""
                if 'http' in proxies:
                    proxy_url = proxies['http']
                elif 'https' in proxies:
                    proxy_url = proxies['https']
                elif 'socks' in proxies:
                    proxy_url = proxies['socks']
                elif 'socks5' in proxies:
                    proxy_url = proxies['socks5']
                
                if proxy_url:
                    # 启用代理并设置代理URL
                    from stconfig import stcfg
                    st_cfg = stcfg()
                    st_cfg.proxy_enabled = True
                    st_cfg.proxy_url = proxy_url
                    st_cfg.save_config()
        except Exception as e:
            print(f"自动设置代理时出错: {str(e)}")

    # 异步检查系统环境（必须在UI初始化之后，但在显示窗口之前）
    async def check_system_environment_async():
        try:
            check_system_environment()
        except Exception as e:
            print(f"系统环境检查时出错: {e}")

    asyncio.create_task(check_system_environment_async())

    # 初始化时根据配置决定是否创建托盘
    if config_manager.get("tray", True):
        async def create_tray_delayed():
            from tray import Tray
            uniUI.ui_event.tray = Tray(page,uniUI.ui_event)
            # 检查是否应该自动启动酒馆
            if config_manager.get("autostart", False):
                page.window.visible = False
                page.update()
                uniUI.ui_event.start_sillytavern(None)

        asyncio.create_task(create_tray_delayed())
    asyncio.create_task(check_first_launch())
    page.window.visible = True
    page.update()

ft.app(target=main, view=ft.AppView.FLET_APP_HIDDEN)