import flet as ft
from time import sleep
from env import Env
from sysenv import SysEnv
from stconfig import stcfg
from ui import UniUI, Terminal
from event import UiEvent
import os
import json

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

    BSytle=ft.ButtonStyle(icon_size=25,text_style=ft.TextStyle(size=20,font_family="Microsoft YaHei"))

    env=Env()
    stCfg=stcfg()
    
    # 读取配置文件
    uniUI=UniUI(page)
    uniUI.setMainView(page)
    ui_event = UiEvent(page, uniUI.terminal)


    
    use_sys_env=ui_event.config["use_sys_env"]
    if use_sys_env:
        tmp=env.checkSysEnv()
        if not tmp==True:
            uniUI.terminal.add_log(tmp)
    else:    
        tmp=env.checkEnv()
        if not tmp==True:
            uniUI.terminal.add_log(tmp)
    page.window.center()


ft.app(target=main, view=ft.AppView.FLET_APP_HIDDEN)
