import flet as ft
from flet import UrlLauncher
from time import sleep
from ui import UniUI
from config import ConfigManager
from update import VersionChecker
import asyncio
import urllib.request
from version import VERSION
from sysenv import SysEnv
from welcome_dialog import show_welcome_dialog

ft.context.disable_auto_update() #修复页面卡卡的感觉

async def main(page: ft.Page):
    await page.window.center()
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
            show_welcome_dialog(page)
            # 更新配置文件，将first_run设置为False
            config_manager.set("first_run", False)
            config_manager.save_config()
    
    # 显示系统环境缺失对话框
    def show_system_env_missing_dialog(missing_items):
        async def close_app_async(_):
            # 关闭对话框
            page.pop_dialog()
            # 关闭整个应用程序
            page.window.visible = False
            page.window.prevent_close = False
            await page.window.close()

        def close_dialog(e):
            page.run_task(close_app_async, e)

        async def open_git_download(e):
            await UrlLauncher().launch_url("https://git-scm.com/install/windows")

        async def open_nodejs_download(e):
            await UrlLauncher().launch_url("https://nodejs.org/zh-cn/download")

        async def open_launcher_download(e):
            await UrlLauncher().launch_url("https://sillytavern.lingyesoul.top/update.html")

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
        # 使用 Flet 的标准 API 显示对话框
        page.show_dialog(dialog)
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

    # 添加窗口关闭时的清理
    def on_window_close(_):
        """窗口关闭时的清理处理"""
        try:
            # 清理所有资源
            if hasattr(uniUI, 'cleanup'):
                uniUI.cleanup()

            # 额外清理：确保终端进程已停止
            if hasattr(uniUI, 'terminal') and uniUI.terminal:
                try:
                    uniUI.terminal.stop_processes()
                except Exception:
                    pass

            # 额外清理：确保数据同步服务器已停止
            if hasattr(uniUI, 'ui_event') and uniUI.ui_event:
                if hasattr(uniUI.ui_event, 'data_sync_manager') and uniUI.ui_event.data_sync_manager:
                    try:
                        uniUI.ui_event.data_sync_manager.stop_sync_server()
                    except Exception:
                        pass

            print("[INFO] 资源清理完成，程序即将退出")
        except Exception as ex:
            print(f"清理资源时出错: {ex}")

    # 保存原始的窗口事件处理
    original_window_event = page.window.on_event

    def combined_window_event(e):
        """组合的窗口事件处理"""
        if e.data == "close":
            on_window_close(e)
        # 调用原始的事件处理（由 UniUI 设置）
        if original_window_event:
            original_window_event(e)

    # 设置组合的窗口事件处理（在 setMainView 之后设置，会覆盖原来的）
    page.window.on_event = combined_window_event

    # 检测启动器版本号，如果是测试版则启用 DEBUG 模式
    def is_prerelease_version(version_str):
        """检测版本号是否为测试版"""
        if not version_str:
            return False

        version_lower = version_str.lower()

        # 检查常见的测试版标识
        prerelease_keywords = [
            'alpha', 'beta', 'rc', 'pre', 'preview',
            'test', 'testing', 'dev', 'development',
            'snapshot', 'nightly', 'experimental',
            '测试版', '测试', '开发版', '预览版'
        ]

        for keyword in prerelease_keywords:
            if keyword in version_lower:
                return True

        return False

    if is_prerelease_version(version):
        uniUI.terminal.enable_debug_mode(True)
        uniUI.terminal.add_log(f"检测到启动器测试版 {version}，已自动启用 DEBUG 模式")

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

ft.run(main, view=ft.AppView.FLET_APP_HIDDEN)