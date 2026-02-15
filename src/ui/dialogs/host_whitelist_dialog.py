"""
主机白名单编辑对话框模块

提供编辑 SillyTavern 主机白名单配置的对话框界面。
"""

import flet as ft


class HostWhitelistDialog:
    """主机白名单编辑对话框类"""

    def __init__(self, page, stcfg, on_save_callback):
        """
        初始化主机白名单对话框

        Args:
            page: Flet 页面对象
            stcfg: SillyTavern 配置对象
            on_save_callback: 保存回调函数 (scan: bool, hosts: list) -> None
        """
        self.page = page
        self.stcfg = stcfg
        self.on_save_callback = on_save_callback
        self.dialog = None

        # UI 控件（初始化为空控件，避免 LSP None 类型错误）
        self.scan_switch = ft.Switch(value=False, visible=False)
        self.hosts_field = ft.TextField(value="", multiline=False, visible=False)

    def _on_save(self, e):
        """
        处理保存按钮点击事件
        """
        scan = self.scan_switch.value
        hosts_text = self.hosts_field.value

        # 解析主机列表（按行分割，去除空行和首尾空格）
        hosts = [line.strip() for line in hosts_text.split("\n") if line.strip()]

        # 先关闭对话框
        self.page.pop_dialog()

        # 调用回调保存配置
        self.on_save_callback(scan, hosts)

    def _on_cancel(self, e):
        """
        处理取消按钮点击事件
        """
        self.page.pop_dialog()

    def _reset_to_default(self, e):
        """
        重置为默认值
        """
        self.scan_switch.value = True
        self.hosts_field.value = "localhost\n127.0.0.1\n[::1]"
        self.page.update()

    def show(self):
        """显示主机白名单编辑对话框"""

        # 扫描开关
        self.scan_switch = ft.Switch(
            label="记录未受信任主机的请求",
            value=self.stcfg.host_whitelist_scan,
        )

        # 主机列表输入框
        hosts_text = "\n".join(self.stcfg.host_whitelist_hosts)
        self.hosts_field = ft.TextField(
            label="受信任的主机列表",
            hint_text="每行一个主机名或IP地址",
            value=hosts_text,
            multiline=True,
            min_lines=6,
            max_lines=12,
            width=600,
            expand=True,
        )

        # 构建对话框
        self.dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("编辑主机白名单", size=18, weight=ft.FontWeight.BOLD),
            content=ft.Container(
                content=ft.Column(
                    [
                        # 说明文本
                        ft.Text(
                            "配置 SillyTavern 的主机白名单，仅允许列表中的主机访问服务器。",
                            size=13,
                            color=ft.Colors.GREY_700,
                        ),
                        ft.Divider(height=15),
                        # 扫描开关
                        ft.Row(
                            [
                                self.scan_switch,
                            ],
                            alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                        ),
                        ft.Text(
                            "记录来自不在白名单中的主机的访问请求，用于监控潜在的安全威胁",
                            size=12,
                            color=ft.Colors.GREY_600,
                        ),
                        ft.Divider(height=15),
                        # 主机列表输入
                        self.hosts_field,
                        ft.Text(
                            "支持格式：主机名（如 localhost）、IP地址（如 192.168.1.100）、IPv6 地址（如 [::1]）",
                            size=12,
                            color=ft.Colors.GREY_600,
                        ),
                    ],
                    scroll=ft.ScrollMode.AUTO,
                    spacing=5,
                ),
                width=700,
                height=450,
                padding=20,
            ),
            actions=[
                # 重置为默认值按钮
                ft.TextButton(
                    "重置为默认值",
                    icon=ft.Icons.REFRESH,
                    on_click=self._reset_to_default,
                ),
                # 取消按钮
                ft.TextButton(
                    "取消",
                    icon=ft.Icons.CANCEL_OUTLINED,
                    on_click=self._on_cancel,
                ),
                # 保存按钮
                ft.Button(
                    "保存",
                    icon=ft.Icons.SAVE,
                    bgcolor=ft.Colors.BLUE_600,
                    color=ft.Colors.WHITE,
                    on_click=self._on_save,
                ),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )

        # 显示对话框
        self.page.show_dialog(self.dialog)


def show_host_whitelist_dialog(page, stcfg, on_save_callback):
    """
    显示主机白名单编辑对话框的便捷函数

    Args:
        page: Flet 页面对象
        stcfg: SillyTavern 配置对象
        on_save_callback: 保存回调函数 (scan: bool, hosts: list) -> None
    """
    dialog = HostWhitelistDialog(page, stcfg, on_save_callback)
    dialog.show()
