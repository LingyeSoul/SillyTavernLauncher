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

    def __init__(self, page, ui_event):
        """
        初始化协议对话框

        Args:
            page: Flet页面对象
            ui_event: UiEvent事件处理对象
        """
        self.page = page
        self.ui_event = ui_event
        self.dialog = None

        # 倒计时相关属性
        self._countdown = 60  # 60秒倒计时
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
        config_manager.set("agreement_version", "2025-01-17")  # 协议版本
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
        self._countdown = 60  # 重置为60秒
        countdown_thread = threading.Thread(target=countdown_worker, daemon=True)
        countdown_thread.start()

    def show(self):
        """显示协议对话框"""
        # 协议内容
        agreement_content = """
SillyTavernLauncher 免责声明与合规使用协议
版本日期：2025年1月17日
生效日期：即日起生效

欢迎使用 SillyTavernLauncher（以下简称"本启动器"）。为了确保您合法、合规地使用本工具，特制定本免责声明与合规说明。请在使用前仔细阅读以下条款。

一、工具性质与免责声明

【功能界定】
• 本启动器仅为 SillyTavern 应用程序的启动管理工具（GUI 启动器）
• 其核心功能在于辅助用户启动主程序
• 不涉及任何内容生成、提示词修改、内容审核或主程序核心功能的运行逻辑
• 本项目本身不参与任何信息内容的生成、存储、传播环节

【责任区分】
• 作为工具提供方，我们仅提供技术层面的启动与管理服务
• 我们不对用户通过本启动器使用 SillyTavern 主程序所产生的任何内容承担法律责任
• 因使用本启动器而产生的任何内容安全、信息合规等法律责任，完全由用户自行承担

二、用户合规义务

用户在使用本启动器及由此启动的 SillyTavern 主程序时，必须严格遵守以下规定：

【遵守法律法规】
• 用户须严格遵守《中华人民共和国网络安全法》
• 《中华人民共和国个人信息保护法》
• 《生成式人工智能服务管理暂行办法》等国家相关法律法规
• 以及 SillyTavern 主程序的用户协议

【禁止非法用途】
• 严禁利用本工具或主程序规避合规要求
• 禁止生成或传播任何包含淫秽色情、暴力恐怖、赌博诈骗、造谣传谣、政治敏感等法律法规禁止的违法不良信息

【维护网络环境】
• 请用户在使用过程中自觉履行网络安全义务
• 遵守公序良俗，共同维护清朗网络空间

三、日志功能与数据处理政策

本启动器内置了日志记录功能，旨在提升技术支持能力。我们就此功能的核心原则声明如下：

1. 功能用途限定
• 日志记录功能仅用于技术故障排查、运行状态监控及功能优化
• 收集范围：严格限定为 SillyTavern 软件运行层面的技术数据，包括但不限于：
  - 进程 ID、接口调用记录、错误代码、系统环境参数等
• 排除范围：本启动器不主动收集任何用户的：
  - 隐私信息、身份信息（如账号、手机号）
  - 或内容交互数据（如聊天内容、对话记录）

2. 数据所有权与控制权
日志数据的生成、存储与使用完全由用户掌控：

• 本地存储：日志文件默认存储在用户本地设备的指定目录（例如：启动器路径/logs/）
• 数据隔离：本启动器不会主动上传、同步或分享日志数据至任何第三方服务器或云端
• 删除权限：用户拥有完全控制权
  - 可手动删除本地日志文件
  - 启动器不会在用户删除后留存任何日志备份

3. 日志数据的合规使用
用户在使用日志功能时，仍需遵守相关法律法规，不得利用日志功能：
• 收集、存储或传播他人的隐私信息及敏感个人信息
• 记录或留存违法违规内容（如涉政、涉黄、涉暴、侵权等内容）
• 将日志数据用于非法用途（包括但不限于商业售卖、恶意攻击、违法取证等）

四、其他条款

【条款更新】
• 本声明内容将根据法律法规及监管要求适时调整
• 如有更新，将在启动器内另行通知
• 更新后的条款一旦公布即代替原条款，恕不另行通知

【最终解释权】
• 本免责声明与合规说明的最终解释权归 SillyTavernLauncher 开发团队所有


您一旦下载、安装或使用本启动器，即视为您已充分理解并同意接受本协议全部内容的约束。

请仔细阅读以上协议内容，并在下方选择是否同意：
        """

        # 倒计时文本（60秒强制阅读）
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


def show_agreement_dialog(page, ui_event):
    """
    显示协议对话框的便捷函数

    Args:
        page: Flet页面对象
        ui_event: UiEvent事件处理对象
    """
    dialog = AgreementDialog(page, ui_event)
    dialog.show()
