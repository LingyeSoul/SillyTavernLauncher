"""
欢迎对话框模块

提供首次启动时的欢迎对话框，包含启动器功能说明和知识问答功能。
"""

import random
import flet as ft
from config import ConfigManager


class WelcomeDialog:
    """欢迎对话框类"""

    # 完整题库（10题）
    QUESTION_BANK = [
        {
            "id": 0,
            "text": "可以将启动器放在包含中文或空格的路径中运行",
            "correct_answer": False,
            "explanation": "启动器路径不能包含中文和空格，否则可能导致Git和Node.js命令执行失败。请确保使用纯英文路径。"
        },
        {
            "id": 1,
            "text": "使用懒人包安装后，仍需点击'安装'按钮安装SillyTavern",
            "correct_answer": False,
            "explanation": "懒人包已经内置了环境和SillyTavern，下载后直接点击'启动'按钮即可运行，无需重复安装。"
        },
        {
            "id": 2,
            "text": "点击'停止'按钮后，SillyTavern会立即关闭，需要重新点击'启动'才能再次运行",
            "correct_answer": True,
            "explanation": "正确。停止按钮会完全关闭SillyTavern进程，下次使用需要重新点击启动。"
        },
        {
            "id": 3,
            "text": "在'设置'页面修改配置后，所有设置都会立即生效",
            "correct_answer": False,
            "explanation": "部分设置（如端口、代理URL等）需要保存，且涉及SillyTavern的配置需要重启酒馆后才能生效。"
        },
        {
            "id": 4,
            "text": "使用系统环境模式时，需要确保已安装Git和Node.js 18+",
            "correct_answer": True,
            "explanation": "正确。系统环境模式依赖您电脑上已安装的Git和Node.js，版本要求为Node.js 18.x或更高。"
        },
        {
            "id": 5,
            "text": "启动器的系统环境模式需要手动安装Git和Node.js",
            "correct_answer": True,
            "explanation": "正确。系统环境模式使用系统已安装的Git和Node.js，需要确保已安装Node.js 18+版本。"
        },
        {
            "id": 6,
            "text": "启动器支持安装，启动，停止，更新SillyTavern",
            "correct_answer": True,
            "explanation": "正确。启动器提供安装，启动，停止，更新SillyTavern功能，这也是启动器主要的4大功能。"
        },
        {
            "id": 7,
            "text": "SillyTavern运行期间可以随时切换版本",
            "correct_answer": False,
            "explanation": "错误。必须先停止当前运行的SillyTavern，才能切换到其他版本。"
        },
        {
            "id": 8,
            "text": "启动器支持多实例同时运行多个SillyTavern版本",
            "correct_answer": False,
            "explanation": "错误。同时间内只能运行一个SillyTavern实例，启动器会自动检测并阻止多实例运行。"
        },
        {
            "id": 9,
            "text": "同步功能需要在局域网内两台设备上都运行启动器",
            "correct_answer": True,
            "explanation": "正确。同步功能需要一台设备作为服务端运行，另一台作为客户端连接，都需要启动启动器。"
        },
        {
            "id": 10,
            "text": "启动器支持设置Github镜像",
            "correct_answer": True,
            "explanation": "正确。启动器提供GitHub镜像设置功能，可以加速国内用户访问GitHub，提升SillyTavern和扩展下载速度。"
        },
        {
            "id": 11,
            "text": "启动器启动的SillyTavern在使用Github镜像源时，可以直接安装来自GitHub的扩展",
            "correct_answer": True,
            "explanation": "正确。使用GitHub镜像源后，SillyTavern可以正常从GitHub镜像安装扩展。"
        }
    ]

    def __init__(self, page):
        """
        初始化欢迎对话框

        Args:
            page: Flet页面对象
        """
        self.page = page
        self.state = {
            'user_answers': {},
            'all_correct': False
        }
        self.ui_controls = {
            'feedback_texts': [],
            'explanation_texts': [],
            'action_button': None,  # 合并的按钮：验证答案/完成并关闭
            'error_text': None
        }
        self.selected_questions = []
        self.dialog = None

    def _create_question_ui(self, q_data, question_index):
        """
        创建单题UI组件

        Args:
            q_data: 题目数据字典
            question_index: 题目索引

        Returns:
            ft.Column: 题目的UI组件
        """
        question_text = ft.Text(
            f"{question_index + 1}. {q_data['text']}",
            size=14,
            weight=ft.FontWeight.W_500
        )

        radio_group = ft.RadioGroup(
            content=ft.Row([
                ft.Radio(value="true", label="√ 正确"),
                ft.Radio(value="false", label="✗ 错误"),
            ], spacing=20),
            on_change=lambda e, idx=question_index: self._on_radio_change(e, idx)
        )

        # 反馈文本（初始隐藏）
        feedback_text = ft.Text(
            "",
            size=13,
            visible=False
        )

        # 解析文本（初始隐藏）
        explanation_text = ft.Text(
            q_data['explanation'],
            size=12,
            color=ft.Colors.GREY_600,
            visible=False
        )

        return ft.Column([
            question_text,
            radio_group,
            feedback_text,
            explanation_text,
            ft.Divider(height=10) if question_index < 4 else ft.Container()
        ], spacing=5)

    def _on_radio_change(self, e, q_id):
        """
        单选按钮变更事件处理

        Args:
            e: 事件对象
            q_id: 题目ID
        """
        self.state['user_answers'][q_id] = (e.data == "true")

    def _on_action_button_click(self, e):
        """
        处理操作按钮点击事件
        - 未验证时：验证答案
        - 已全部答对：关闭对话框
        """
        # 如果已全部答对，关闭对话框
        if self.state['all_correct']:
            self._close_dialog(e)
            return

        # 检查是否全部作答
        if len(self.state['user_answers']) < len(self.selected_questions):
            self.ui_controls['error_text'].value = "请回答所有问题后再验证"
            self.ui_controls['error_text'].color = ft.Colors.RED_600
            self.ui_controls['error_text'].visible = True
            self.page.update()
            return

        correct_count = 0

        # 逐题验证
        for i, q_data in enumerate(self.selected_questions):
            user_answer = self.state['user_answers'].get(i)
            if user_answer is None:
                continue

            is_correct = (user_answer == q_data['correct_answer'])

            # 更新反馈文本
            feedback = self.ui_controls['feedback_texts'][i]
            explanation = self.ui_controls['explanation_texts'][i]

            if is_correct:
                feedback.value = "✓ 回答正确"
                feedback.color = ft.Colors.GREEN_600
                explanation.visible = False
                correct_count += 1
            else:
                feedback.value = "✗ 回答错误"
                feedback.color = ft.Colors.RED_600
                explanation.visible = True

            feedback.visible = True

        # 判断是否全部正确
        if correct_count == len(self.selected_questions):
            self.state['all_correct'] = True
            self.ui_controls['error_text'].value = "恭喜！您已全部回答正确！"
            self.ui_controls['error_text'].color = ft.Colors.GREEN_600

            # 更改按钮为"完成并关闭"
            self.ui_controls['action_button'].text = "完成并关闭"
            self.ui_controls['action_button'].icon = ft.Icons.DONE
            self.ui_controls['action_button'].bgcolor = ft.Colors.GREEN_600
        else:
            self.ui_controls['error_text'].value = f"有 {len(self.selected_questions) - correct_count} 题错误，请查看上方解析后重新作答"
            self.ui_controls['error_text'].color = ft.Colors.ORANGE_600

        self.ui_controls['error_text'].visible = True
        self.page.update()

    def _close_dialog(self, e):
        """
        关闭对话框并保存状态

        Args:
            e: 事件对象
        """
        config_manager = ConfigManager()
        config_manager.set("first_run", False)
        config_manager.save_config()
        # 使用正确的 API 关闭对话框（适配 Flet 0.80.1）
        self.dialog.open = False
        self.page.update()

    def show(self):
        """显示欢迎对话框"""
        # 随机抽取5题并按ID排序
        self.selected_questions = random.sample(self.QUESTION_BANK, 5)
        self.selected_questions.sort(key=lambda x: x['id'])

        # 构建题目列表
        questions_column = ft.Column([], spacing=10)
        for i, q_data in enumerate(self.selected_questions):
            question_ui = self._create_question_ui(q_data, i)
            questions_column.controls.append(question_ui)

            # 保存反馈文本引用
            feedback = question_ui.controls[2]
            explanation = question_ui.controls[3]
            self.ui_controls['feedback_texts'].append(feedback)
            self.ui_controls['explanation_texts'].append(explanation)

        # 错误提示文本
        error_text = ft.Text("", visible=False, size=14, weight=ft.FontWeight.W_500)
        self.ui_controls['error_text'] = error_text

        # 构建对话框
        self.dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("欢迎使用 SillyTavernLauncher", size=18, weight=ft.FontWeight.BOLD),
            content=ft.Container(
                content=ft.Column([
                    # 功能介绍区
                    ft.Text("功能介绍", size=16, weight=ft.FontWeight.BOLD),
                    ft.Text("主要功能：", size=13, weight=ft.FontWeight.W_500),
                    ft.Text("• 一键安装：自动下载并配置SillyTavern及所需环境", size=13),
                    ft.Text("• 便捷启动：简化启动流程，无需手动输入命令", size=13),
                    ft.Text("• 版本管理：支持多版本切换、回滚和自动更新检查", size=13),
                    ft.Text("• 多种模式：内置环境模式（懒人包所使用的模式）、系统环境模式（需自行安装环境）", size=13),
                    ft.Text("• 数据同步：支持局域网内多设备间数据同步功能", size=13),
                    ft.Text("• 丰富设置：提供端口配置、代理设置等详细配置选项", size=13),
                    ft.Text("• 日志查看：实时查看启动和运行日志，便于问题排查", size=13),
                    ft.Divider(height=20, color=ft.Colors.BLUE_200),

                    # 重要提示区
                    ft.Text("重要提示", size=16, weight=ft.FontWeight.BOLD, color=ft.Colors.RED_600),
                    ft.Text("⚠ 请勿使用包含中文或空格的路径！", size=14, color=ft.Colors.RED_600),
                    ft.Text("⚠ 懒人包用户请直接点击'启动'按钮，无需重复安装", size=14, color=ft.Colors.RED_600),
                    ft.Text("⚠ 系统环境模式需确保已安装Node.js 18+和Git", size=14, color=ft.Colors.RED_600),
                    ft.Text("⚠ 同步功能仅在局域网内使用，注意保护数据安全", size=14, color=ft.Colors.RED_600),
                    ft.Divider(height=20),

                    # 答题区
                    ft.Text("知识问答", size=16, weight=ft.FontWeight.BOLD),
                    ft.Text("请回答以下问题以确保您已了解启动器的使用方法", size=13),
                    ft.Divider(height=10),

                    questions_column,

                    # 底部提示
                    error_text,
                ], scroll=ft.ScrollMode.AUTO, spacing=8),
                width=650,
                height=700,
                padding=20
            ),
            actions=[
                ft.TextButton(
                    "酒馆入门教程",
                    on_click=lambda _: self.page.launch_url("https://www.yuque.com/yinsa-0wzmf/rcv7g3?", web_window_name="sillytaverntutorial")
                ),
                ft.TextButton(
                    "启动器官网",
                    on_click=lambda _: self.page.launch_url("https://sillytavern.lingyesoul.top", web_window_name="sillytavernlauncher")
                ),
                ft.ElevatedButton(
                    "验证答案",
                    icon=ft.Icons.CHECK,
                    bgcolor=ft.Colors.BLUE_600,
                    color=ft.Colors.WHITE,
                    on_click=self._on_action_button_click
                ),
            ],
            actions_alignment=ft.MainAxisAlignment.END
        )

        # 保存按钮引用
        self.ui_controls['action_button'] = self.dialog.actions[2]  # 操作按钮（验证答案/完成并关闭）

        # 使用 overlay 显示对话框（适配 Flet 0.80.1）
        self.page.overlay.append(self.dialog)
        self.dialog.open = True
        self.page.update()


def show_welcome_dialog(page):
    """
    显示欢迎对话框的便捷函数

    Args:
        page: Flet页面对象
    """
    dialog = WelcomeDialog(page)
    dialog.show()
