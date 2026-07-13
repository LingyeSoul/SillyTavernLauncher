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
        self.private_enabled_switch = ft.Switch(value=False, visible=False)
        self.allow_unresolved_switch = ft.Switch(value=False, visible=False)
        self.log_blocked_switch = ft.Switch(value=False, visible=False)
        self.log_allowed_switch = ft.Switch(value=False, visible=False)
        self.private_ranges_field = ft.TextField(
            value="", multiline=False, visible=False
        )

    @staticmethod
    def _parse_lines(value: str) -> list[str]:
        """解析并去重多行白名单内容。"""
        return list(
            dict.fromkeys(line.strip() for line in value.splitlines() if line.strip())
        )

    def _append_current_subnet(self, field: ft.TextField) -> None:
        """将智能检测到的当前网段追加到指定白名单输入框。"""
        subnet = self.stcfg.get_current_subnet()
        if not subnet:
            return

        entries = self._parse_lines(field.value or "")
        if subnet not in entries:
            entries.insert(0, subnet)
            field.value = "\n".join(entries)
            self.page.update()

    def _on_save(self, e):
        mode = self.mode_switch.value
        forwarded = self.forwarded_switch.value
        ips = self._parse_lines(self.ips_field.value or "")
        private_enabled = self.private_enabled_switch.value
        allowed_ranges = self._parse_lines(self.private_ranges_field.value or "")
        allow_unresolved = self.allow_unresolved_switch.value
        log_blocked = self.log_blocked_switch.value
        log_allowed = self.log_allowed_switch.value

        self.page.pop_dialog()
        self.on_save_callback(
            mode,
            forwarded,
            ips,
            private_enabled,
            allowed_ranges,
            allow_unresolved,
            log_blocked,
            log_allowed,
        )

    def _on_cancel(self, e):
        self.page.pop_dialog()

    def _reset_to_default(self, e):
        self.mode_switch.value = True
        self.forwarded_switch.value = True
        self.ips_field.value = "::1\n127.0.0.1"
        self.private_enabled_switch.value = False
        self.allow_unresolved_switch.value = False
        self.log_blocked_switch.value = True
        self.log_allowed_switch.value = False
        self.private_ranges_field.value = "127.0.0.0/8\n::1/128"
        self.page.update()

    def _add_current_subnet(self, e):
        self._append_current_subnet(self.ips_field)

    def _add_current_private_subnet(self, e):
        self._append_current_subnet(self.private_ranges_field)

    def show(self):
        self.mode_switch = ft.Switch(
            label="启用 IP 白名单过滤",
            value=self.stcfg.whitelist_mode,
        )
        self.forwarded_switch = ft.Switch(
            label="检查转发头中的白名单 IP",
            value=self.stcfg.enable_forwarded_whitelist,
        )
        self.ips_field = ft.TextField(
            label="允许的 IP 地址列表",
            hint_text="每行一个 IP 地址或网段",
            value="\n".join(self.stcfg.whitelist_ips),
            multiline=True,
            min_lines=4,
            max_lines=8,
            width=600,
            expand=True,
        )

        self.private_enabled_switch = ft.Switch(
            label="启用私有地址请求过滤（SSRF 防护）",
            value=self.stcfg.private_address_whitelist_enabled,
        )
        self.allow_unresolved_switch = ft.Switch(
            label="允许无法解析的主机",
            value=self.stcfg.private_address_allow_unresolved_hosts,
        )
        self.log_blocked_switch = ft.Switch(
            label="记录被阻止的请求",
            value=self.stcfg.private_address_log_blocked,
        )
        self.log_allowed_switch = ft.Switch(
            label="记录已允许的请求",
            value=self.stcfg.private_address_log_allowed,
        )
        self.private_ranges_field = ft.TextField(
            label="可信私有地址范围",
            hint_text="每行一个 IP、CIDR 或通配符网段",
            value="\n".join(self.stcfg.private_address_allowed_ranges),
            multiline=True,
            min_lines=4,
            max_lines=8,
            width=600,
            expand=True,
        )

        self.dialog = ft.AlertDialog(
            modal=True,
            title=ft.Row(
                [
                    ft.Icon(ft.Icons.SECURITY, color=ft.Colors.BLUE_600),
                    ft.Text("网络白名单", size=18, weight=ft.FontWeight.BOLD),
                ],
                spacing=10,
            ),
            content=ft.Container(
                content=ft.Column(
                    [
                        ft.Text(
                            "访问来源",
                            size=15,
                            weight=ft.FontWeight.BOLD,
                        ),
                        self.mode_switch,
                        ft.Text(
                            "启用后，只有白名单中的 IP 才能访问服务",
                            size=12,
                            color=ft.Colors.GREY_600,
                        ),
                        self.forwarded_switch,
                        ft.Row(
                            [
                                self.ips_field,
                                ft.IconButton(
                                    icon=ft.Icons.ADD_LINK,
                                    tooltip="添加当前网段到访问来源白名单",
                                    on_click=self._add_current_subnet,
                                ),
                            ],
                            vertical_alignment=ft.CrossAxisAlignment.CENTER,
                        ),
                        ft.Text(
                            "支持 IPv4、IPv6、CIDR 和通配符网段",
                            size=12,
                            color=ft.Colors.GREY_600,
                        ),
                        ft.Divider(height=24),
                        ft.Text(
                            "私有地址请求保护",
                            size=15,
                            weight=ft.FontWeight.BOLD,
                        ),
                        self.private_enabled_switch,
                        ft.Text(
                            "阻止服务器请求未受信任的私有地址，重启酒馆后生效",
                            size=12,
                            color=ft.Colors.GREY_600,
                        ),
                        ft.Row(
                            [
                                self.private_ranges_field,
                                ft.IconButton(
                                    icon=ft.Icons.ADD_LINK,
                                    tooltip="信任当前网段",
                                    on_click=self._add_current_private_subnet,
                                ),
                            ],
                            vertical_alignment=ft.CrossAxisAlignment.CENTER,
                        ),
                        self.allow_unresolved_switch,
                        ft.Text(
                            "仅在确有需要时开启；无法解析的主机将绕过此项检查",
                            size=12,
                            color=ft.Colors.ORANGE_700,
                        ),
                        self.log_blocked_switch,
                        self.log_allowed_switch,
                    ],
                    scroll=ft.ScrollMode.AUTO,
                    spacing=7,
                ),
                width=700,
                height=500,
                padding=20,
            ),
            actions=[
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
