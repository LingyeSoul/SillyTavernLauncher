import flet as ft


class IpWhitelistDialog:
    def __init__(self, page, stcfg, on_save_callback):
        self.page = page
        self.stcfg = stcfg
        self.on_save_callback = on_save_callback
        self.dialog = None

        self.mode_switch = ft.Switch(value=False, visible=False)
        self.forwarded_switch = ft.Switch(value=False, visible=False)
        self.ips_field = ft.TextField(value="", multiline=False, visible=False)

    def _on_save(self, e):
        mode = self.mode_switch.value
        forwarded = self.forwarded_switch.value
        ips_text = self.ips_field.value

        ips = [line.strip() for line in ips_text.split("\n") if line.strip()]

        self.page.pop_dialog()
        self.on_save_callback(mode, forwarded, ips)

    def _on_cancel(self, e):
        self.page.pop_dialog()

    def _reset_to_default(self, e):
        self.mode_switch.value = True
        self.forwarded_switch.value = True
        self.ips_field.value = "::1\n127.0.0.1"
        self.page.update()

    def _add_current_subnet(self, e):
        from core.network import get_network_manager

        network_manager = get_network_manager()
        local_ip = network_manager.get_local_ip()

        if local_ip:
            parts = local_ip.split(".")
            if len(parts) == 4:
                subnet = f"{parts[0]}.{parts[1]}.{parts[2]}.*"
                current_ips = self.ips_field.value
                if subnet not in current_ips:
                    self.ips_field.value = f"{subnet}\n{current_ips}".strip()
                    self.page.update()

    def show(self):
        self.mode_switch = ft.Switch(
            label="启用 IP 白名单过滤",
            value=self.stcfg.whitelist_mode,
        )

        self.forwarded_switch = ft.Switch(
            label="检查转发头中的白名单 IP",
            value=self.stcfg.enable_forwarded_whitelist,
        )

        ips_text = "\n".join(self.stcfg.whitelist_ips)
        self.ips_field = ft.TextField(
            label="允许的 IP 地址列表",
            hint_text="每行一个 IP 地址或网段",
            value=ips_text,
            multiline=True,
            min_lines=6,
            max_lines=12,
            width=600,
            expand=True,
        )

        self.dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("编辑 IP 白名单", size=18, weight=ft.FontWeight.BOLD),
            content=ft.Container(
                content=ft.Column(
                    [
                        ft.Text(
                            "配置 SillyTavern 的 IP 白名单，仅允许列表中的 IP 访问服务器。",
                            size=13,
                            color=ft.Colors.GREY_700,
                        ),
                        ft.Divider(height=15),
                        ft.Row(
                            [self.mode_switch],
                            alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                        ),
                        ft.Text(
                            "启用后，只有白名单中的 IP 才能访问服务",
                            size=12,
                            color=ft.Colors.GREY_600,
                        ),
                        ft.Divider(height=10),
                        ft.Row(
                            [self.forwarded_switch],
                            alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                        ),
                        ft.Text(
                            "检查 X-Forwarded-For 等转发头中的 IP",
                            size=12,
                            color=ft.Colors.GREY_600,
                        ),
                        ft.Divider(height=15),
                        self.ips_field,
                        ft.Text(
                            "支持格式：IPv4 (如 127.0.0.1)、IPv6 (如 ::1)、网段通配符 (如 192.168.1.*)",
                            size=12,
                            color=ft.Colors.GREY_600,
                        ),
                    ],
                    scroll=ft.ScrollMode.AUTO,
                    spacing=5,
                ),
                width=700,
                height=500,
                padding=20,
            ),
            actions=[
                ft.TextButton(
                    "添加当前网段",
                    icon=ft.Icons.ADD,
                    on_click=self._add_current_subnet,
                ),
                ft.TextButton(
                    "重置为默认值",
                    icon=ft.Icons.REFRESH,
                    on_click=self._reset_to_default,
                ),
                ft.TextButton(
                    "取消",
                    icon=ft.Icons.CANCEL_OUTLINED,
                    on_click=self._on_cancel,
                ),
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

        self.page.show_dialog(self.dialog)


def show_ip_whitelist_dialog(page, stcfg, on_save_callback):
    dialog = IpWhitelistDialog(page, stcfg, on_save_callback)
    dialog.show()
