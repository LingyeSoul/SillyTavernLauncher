"""
安装前确认对话框模块

在用户首次下载(git clone) SillyTavern前弹出合规确认对话框。
"""

import flet as ft


class InstallConfirmDialog:
    """安装前确认对话框"""

    def __init__(self, page, callback):
        """
        初始化安装确认对话框

        Args:
            page: Flet页面对象
            callback: 回调函数，接收一个bool参数(True=确认, False=取消)
        """
        self.page = page
        self.callback = callback

    def _on_confirm(self, e):
        """确认下载"""
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
                        "未成年人严禁使用。是否继续？",
                        size=14,
                        selectable=True,
                    ),
                ], spacing=10),
                width=500,
                height=50,
                padding=10,
            ),
            actions=[
                ft.TextButton(
                    "取消",
                    on_click=self._on_cancel,
                ),
                ft.Button(
                    "确认下载",
                    icon=ft.Icons.DOWNLOAD,
                    bgcolor=ft.Colors.BLUE_600,
                    color=ft.Colors.WHITE,
                    on_click=self._on_confirm,
                    style=ft.ButtonStyle(
                        shape=ft.RoundedRectangleBorder(radius=8),
                    )
                ),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )
        self.page.show_dialog(dialog)


def show_install_confirm_dialog(page, callback):
    """
    显示安装确认对话框的便捷函数

    Args:
        page: Flet页面对象
        callback: 回调函数，接收一个bool参数(True=确认, False=取消)
    """
    dialog = InstallConfirmDialog(page, callback)
    dialog.show()
