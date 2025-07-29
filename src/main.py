import flet as ft
from time import sleep
from env import Env
from sysenv import SysEnv
from stconfig import stcfg
from ui import UniUI, Terminal
from event import UiEvent
import json
import os


def main(page: ft.Page):
    page.window.center()
    page.window.visible = True
    page.title = "SillyTavernLauncher"
    page.theme = ft.Theme(color_scheme_seed=ft.Colors.BLUE,font_family="Microsoft YaHei")
    page.dark_theme=ft.Theme(color_scheme_seed=ft.Colors.BLUE,font_family="Microsoft YaHei")
    page.window.width = 800
    page.window.height = 640
    page.window.resizable = False
    page.window.min_height=640
    page.window.min_width=800
    page.window.maximizable = False
    page.window.title_bar_hidden = True
    
    def showMsg(v):
        page.open(ft.SnackBar(ft.Text(v),show_close_icon=True,duration=3000))

    # 检查是否为首次启动
    def check_first_launch():
        config_path = os.path.join(os.getcwd(), "config.json")
        
        # 检查配置文件是否存在
        if os.path.exists(config_path):
            try:
                with open(config_path, "r") as f:
                    config = json.load(f)
                # 检查first_run参数是否存在且为True
                if config.get("first_run", True):
                    # 显示欢迎对话框
                    show_welcome_dialog()
                    # 更新配置文件，将first_run设置为False
                    config["first_run"] = False
                    with open(config_path, "w") as f:
                        json.dump(config, f, indent=4)
            except Exception as e:
                show_welcome_dialog()
    
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

    #BSytle=ft.ButtonStyle(icon_size=25,text_style=ft.TextStyle(size=20,font_family="Microsoft YaHei"))

    uniUI=UniUI(page)
    uniUI.setMainView(page)
    #ui_event = UiEvent(page, uniUI.terminal)

    page.window.center()
    page.update()
    check_first_launch()
    


ft.app(target=main, view=ft.AppView.FLET_APP_HIDDEN)