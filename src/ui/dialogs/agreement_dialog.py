"""
使用协议对话框模块

提供首次启动时的使用协议对话框，确保用户同意免责声明和合规使用协议。
"""

import asyncio

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

    async def _run_countdown(self):
        """在 Flet 事件循环中运行倒计时并更新控件。"""
        while self._countdown > 0 and self._countdown_active:
            await asyncio.sleep(1)
            if not self._countdown_active or self.page is None:
                break

            self._countdown -= 1
            self._countdown_text.value = (
                f"⏳ 请仔细阅读协议内容（{self._countdown}秒后可同意）"
            )
            if self._countdown == 0:
                self._agree_button.disabled = False
                self._countdown_text.value = "✅ 您现在可以同意协议了"
                self._countdown_text.color = ft.Colors.GREEN_600
                self._countdown_text.weight = ft.FontWeight.BOLD

            try:
                self.page.update()
            except (AssertionError, RuntimeError):
                self._countdown_active = False
                break

    def _start_countdown(self):
        """启动30秒倒计时"""
        self._countdown_active = True
        self._countdown = 30 # 重置为30
        if self.page:
            try:
                self._countdown_timer = self.page.run_task(self._run_countdown)
            except (AssertionError, RuntimeError):
                self._countdown_active = False

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
        actions = self.dialog.actions
        self._agree_button = actions[1] if len(actions) > 1 else None

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


def show_network_error_dialog(page, error_msg=""):
    """
    显示协议获取失败对话框（不可关闭，仅可退出程序）

    Args:
        page: Flet页面对象
        error_msg: 错误详细信息
    """
    error_detail = ft.Text(
        str(error_msg)[:500],
        size=12,
        color=ft.Colors.GREY_700,
        selectable=True,
        visible=bool(error_msg),
    )

    dialog = ft.AlertDialog(
        modal=True,
        barrier_dismissible=False,
        title=ft.Row([
            ft.Icon(ft.Icons.ERROR_OUTLINE, size=28, color=ft.Colors.RED_600),
            ft.Text("协议获取失败", size=18, weight=ft.FontWeight.BOLD),
        ], spacing=10),
        content=ft.Container(
            content=ft.Column([
                ft.Text(
                    "无法获取使用协议内容，应用程序无法继续运行。",
                    size=14,
                ),
                ft.Text(
                    "请检查网络连接后重新启动程序。",
                    size=13,
                    color=ft.Colors.GREY_600,
                ),
                ft.Divider(height=10),
                error_detail,
            ], spacing=5),
            width=500,
            padding=5,
        ),
        actions=[
            ft.Button(
                "退出程序",
                icon=ft.Icons.EXIT_TO_APP,
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
