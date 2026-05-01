"""
安装前确认对话框模块

在用户首次下载(git clone) SillyTavern前弹出合规确认对话框。
"""

import flet as ft


class InstallConfirmDialog:
    """安装前确认对话框"""

    def __init__(self, page, callback):
        self.page = page
        self.callback = callback
        self._confirm_button = None
        self._age_checkbox = None

    def _on_age_check(self, e):
        """年龄勾选变化时切换确认按钮状态"""
        self._confirm_button.disabled = not self._age_checkbox.value
        self.page.update()

    def _on_confirm(self, e):
        """确认下载"""
        if not self._age_checkbox.value:
            return
        self.page.pop_dialog()
        if self.callback:
            self.callback(True)

    def _on_cancel(self, e):
        """取消下载"""
        self.page.pop_dialog()
        if self.callback:
            self.callback(False)

    def show(self):
        """显示安装确认对话框"""
        self._age_checkbox = ft.Checkbox(
            label="我已确认本人已年满18周岁，或作为未满18周岁用户已取得监护人同意",
            on_change=self._on_age_check,
        )

        self._confirm_button = ft.Button(
            "确认下载",
            icon=ft.Icons.DOWNLOAD,
            bgcolor=ft.Colors.BLUE_600,
            color=ft.Colors.WHITE,
            disabled=True,
            on_click=self._on_confirm,
            style=ft.ButtonStyle(
                shape=ft.RoundedRectangleBorder(radius=8),
            )
        )

        dialog = ft.AlertDialog(
            modal=True,
            title=ft.Row([
                ft.Icon(ft.Icons.WARNING, size=28, color=ft.Colors.ORANGE_600),
                ft.Text("安装确认", size=18, weight=ft.FontWeight.BOLD),
            ], spacing=10),
            content=ft.Container(
                content=ft.Column([
                    ft.Text(
                        "您即将下载第三方开源软件 SillyTavern。该软件可能支持 AI 角色扮演、情感互动等功能，"
                        "使用这些功能需遵守《人工智能拟人化互动服务管理暂行办法》。"
                        "本启动器不建议未满18周岁用户独立使用。未满14周岁用户须在监护人明确知情并同意的前提下使用。",
                        size=14,
                        selectable=True,
                    ),
                    ft.Divider(height=5),
                    self._age_checkbox,
                ], spacing=8),
                width=600,
                padding=10,
            ),
            actions=[
                ft.TextButton(
                    "取消",
                    on_click=self._on_cancel,
                ),
                self._confirm_button,
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )
        self.page.show_dialog(dialog)


def show_install_confirm_dialog(page, callback):
    dialog = InstallConfirmDialog(page, callback)
    dialog.show()
