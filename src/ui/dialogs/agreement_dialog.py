"""
使用协议对话框模块

提供首次启动时的使用协议对话框，确保用户同意免责声明和合规使用协议。
"""

import sys
import time
import threading
import flet as ft
from config.config_manager import ConfigManager


class AgreementDialog:
    """使用协议对话框类"""

    def __init__(self, page, ui_event, content_text="", version_date=""):
        """
        初始化协议对话框

        Args:
            page: Flet页面对象
            ui_event: UiEvent事件处理对象
            content_text: 协议内容文本（远程获取）
            version_date: 协议版本日期（远程获取）
        """
        self.page = page
        self.ui_event = ui_event
        self.dialog = None
        self.content_text = content_text
        self.version_date = version_date

        # 倒计时相关属性
        self._countdown = 30 # 30倒计时
        self._countdown_active = False
        self._countdown_timer = None
        self._countdown_text = None  # 倒计时文本控件引用
        self._agree_button = None  # 同意按钮控件引用

    def _on_disagree(self, e):
        """
        处理不同意按钮点击事件 - 退出程序

        Args:
            e: 事件对象
        """
        # 停止倒计时
        self._countdown_active = False
        # 关闭对话框
        self.page.pop_dialog()
        # 调用event中的退出程序方法
        self.ui_event._exit_app_full(stop_processes=False)
        

    def _on_agree(self, e):
        """
        处理同意按钮点击事件 - 关闭对话框并保存状态

        Args:
            e: 事件对象
        """
        # 停止倒计时
        self._countdown_active = False
        # 保存同意状态
        config_manager = ConfigManager()
        config_manager.set("agreement_accepted", True)
        config_manager.set("agreement_version", self.version_date)  # 协议版本（动态）
        config_manager.save_config()

        # 关闭对话框
        self.page.pop_dialog()

    def _update_countdown(self):
        """更新倒计时（每秒更新UI）"""
        if self._countdown > 0:
            self._countdown -= 1
            self._countdown_text.value = f"⏳ 请仔细阅读协议内容（{self._countdown}秒后可同意）"

            # 倒计时结束，启用同意按钮
            if self._countdown == 0:
                self._agree_button.disabled = False
                self._countdown_text.value = "✅ 您现在可以同意协议了"
                self._countdown_text.color = ft.Colors.GREEN_600
                self._countdown_text.weight = ft.FontWeight.BOLD

            # 使用 page.run_task() 调度UI更新（参考 sync_ui.py）
            if self.page:
                try:
                    async def update_ui():
                        """异步更新UI"""
                        try:
                            self.page.update()
                        except (AssertionError, RuntimeError) as e:
                            if "Event loop is closed" in str(e):
                                self._countdown_active = False
                            raise

                    self.page.run_task(update_ui)
                except (AssertionError, RuntimeError) as e:
                    # 如果 run_task 失败，回退到同步更新
                    try:
                        self.page.update()
                    except Exception:
                        self._countdown_active = False

    def _start_countdown(self):
        """启动30秒倒计时"""
        def countdown_worker():
            while self._countdown > 0 and self._countdown_active:
                time.sleep(1)
                if self._countdown_active and self.page:
                    # 调用UI更新，Flet会自动处理线程调度
                    self._update_countdown()

        self._countdown_active = True
        self._countdown = 30 # 重置为30
        countdown_thread = threading.Thread(target=countdown_worker, daemon=True)
        countdown_thread.start()

    def show(self):
        """显示协议对话框"""
        # 协议内容由远程获取
        agreement_content = self.content_text

        # 倒计时文本（30强制阅读）
        self._countdown_text = ft.Text(
            f"⏳ 请仔细阅读协议内容（{self._countdown}秒后可同意）",
            size=16,
            weight=ft.FontWeight.BOLD,
            color=ft.Colors.ORANGE_600
        )

        # 构建对话框
        self.dialog = ft.AlertDialog(
            modal=True,
            title=ft.Row([
                ft.Icon(ft.Icons.GAVEL, size=30, color=ft.Colors.RED_600),
                ft.Text("使用协议", size=20, weight=ft.FontWeight.BOLD),
            ], spacing=10),
            content=ft.Container(
                content=ft.Column([
                    # 倒计时提示
                    self._countdown_text,
                    ft.Divider(height=10, color=ft.Colors.ORANGE_200),

                    # 重要提示
                    ft.Container(
                        content=ft.Column([
                            ft.Text(
                                "⚠ 重要提示",
                                size=16,
                                weight=ft.FontWeight.BOLD,
                                color=ft.Colors.RED_600
                            ),
                            ft.Text(
                                "在继续使用前，请仔细阅读并同意本免责声明与合规使用协议",
                                size=13,
                                color=ft.Colors.RED_700
                            ),
                        ], spacing=5),
                        padding=15,
                        bgcolor=ft.Colors.RED_50,
                        border_radius=8,
                    ),
                    ft.Divider(height=15, color=ft.Colors.RED_200),
                    ft.Text(
                        agreement_content,
                        size=14,
                        selectable=True,  # 允许用户选择文本
                        font_family="Microsoft YaHei"),
                ], scroll=ft.ScrollMode.AUTO, spacing=10),
                width=750,
                height=700,
                padding=20
            ),
            actions=[
                # 不同意按钮
                ft.Button(
                    "不同意并退出",
                    icon=ft.Icons.CANCEL,
                    bgcolor=ft.Colors.RED_600,
                    color=ft.Colors.WHITE,
                    on_click=self._on_disagree,
                    style=ft.ButtonStyle(
                        shape=ft.RoundedRectangleBorder(radius=8),
                    )
                ),
                # 同意按钮（初始禁用，倒计时结束后启用）
                ft.Button(
                    "我已阅读并同意",
                    icon=ft.Icons.CHECK_CIRCLE,
                    bgcolor=ft.Colors.GREEN_600,
                    color=ft.Colors.WHITE,
                    disabled=True,  # 初始禁用
                    on_click=self._on_agree,
                    style=ft.ButtonStyle(
                        shape=ft.RoundedRectangleBorder(radius=8),
                    )
                ),
            ],
            actions_alignment=ft.MainAxisAlignment.SPACE_BETWEEN
        )

        # 保存同意按钮引用
        self._agree_button = self.dialog.actions[1]

        # 使用 Flet 的标准 API 显示对话框
        self.page.show_dialog(self.dialog)

        # 启动倒计时
        self._start_countdown()


def show_agreement_dialog(page, ui_event, content_text="", version_date=""):
    """
    显示协议对话框的便捷函数

    Args:
        page: Flet页面对象
        ui_event: UiEvent事件处理对象
        content_text: 协议内容文本（远程获取）
        version_date: 协议版本日期（远程获取）
    """
    dialog = AgreementDialog(page, ui_event, content_text, version_date)
    dialog.show()


def show_network_error_dialog(page):
    dialog = ft.AlertDialog(
        modal=True,
        title=ft.Row([
            ft.Icon(ft.Icons.WIFI_OFF, size=28, color=ft.Colors.RED_600),
            ft.Text("网络连接失败", size=18, weight=ft.FontWeight.BOLD),
        ], spacing=10),
        content=ft.Text(
            "无法连接服务器获取使用协议，请检查网络后重试。",
            size=14,
        ),
        actions=[
            ft.Button(
                "退出程序",
                bgcolor=ft.Colors.RED_600,
                color=ft.Colors.WHITE,
                on_click=lambda e: page.window.close(),
                style=ft.ButtonStyle(
                    shape=ft.RoundedRectangleBorder(radius=8),
                )
            ),
        ],
        actions_alignment=ft.MainAxisAlignment.END,
    )
    page.show_dialog(dialog)
