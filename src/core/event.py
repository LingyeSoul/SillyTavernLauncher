import threading
import os
import flet as ft
from features.system.env import Env
from config.config_manager import ConfigManager
from features.st.config import stcfg
from features.system.env_sys import SysEnv
import subprocess
import json
import asyncio
from packaging import version
import urllib.request
from core.git_utils import switch_git_remote_to_gitee
import re
from utils.logger import app_logger


class UiEvent:
    def __init__(self, page, terminal, uni_ui=None):
        self.page = page
        self.terminal = terminal
        self.uni_ui = uni_ui

        # ========== 初始化配置管理器 ==========
        try:
            self.config_manager = ConfigManager()
            self.config = (
                self.config_manager.config
                if self.config_manager and hasattr(self.config_manager, "config")
                else {}
            )
            if not isinstance(self.config, dict):
                app_logger.warning(
                    f"config 不是字典类型: {type(self.config)}，使用空字典"
                )
                self.config = {}
        except Exception as e:
            app_logger.error(f"ConfigManager初始化异常: {e}", exc_info=True)
            self.config_manager = None
            self.config = {}

        use_sys_env = self.config.get("use_sys_env", False) if self.config else False
        if use_sys_env:
            self.env = SysEnv()
            tmp = self.env.checkSysEnv()
            if not tmp == True:
                self.terminal.add_log(tmp)
        else:
            self.env = Env()
            tmp = self.env.checkEnv()
            if not tmp == True:
                self.terminal.add_log(tmp)
        self.stCfg = stcfg()
        self.tray = None  # 添加tray引用

    def run_async_task(self, coroutine):
        """运行异步任务"""

        def run_in_thread():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(coroutine)
            finally:
                loop.close()

        thread = threading.Thread(target=run_in_thread, daemon=True)
        thread.start()

    def show_error_dialog(self, title, message):
        """
        显示错误对话框，带复制按钮

        Args:
            title (str): 对话框标题
            message (str): 错误消息
        """
        page = self.page

        dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text(title, size=18, color=ft.Colors.RED_600),
            content=ft.Column(
                [
                    ft.Text(message, size=13),
                ],
                tight=True,
                horizontal_alignment=ft.CrossAxisAlignment.START,
            ),
            actions=[
                ft.TextButton(
                    "复制错误信息",
                    icon=ft.Icons.COPY,
                    on_click=lambda e: self._copy_to_clipboard_wrapper(message, page),
                ),
                ft.Button("确定", on_click=lambda e: page.pop_dialog()),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )

        # 使用 Flet 的标准 API 显示对话框
        page.show_dialog(dialog)

    def _copy_to_clipboard_wrapper(self, text, page):
        """复制到剪贴板的包装函数（用于同步 event handler）"""

        async def copy_async():
            await ft.Clipboard().set(text)
            page.show_dialog(ft.SnackBar(ft.Text("已复制到剪贴板")))

        page.run_task(copy_async)

    def validate_custom_args(self, args: str) -> tuple[bool, str]:
        """
        验证自定义启动参数是否安全，防止命令注入攻击

        安全规则：
        1. 只允许安全的参数格式：--flag, --key=value, -k, -k value
        2. 不允许 shell 元字符：|, &, ;, $, `, (, ), <, >, \n, \r
        3. 不允许未闭合的引号
        4. 参数值只允许字母、数字、下划线、短横线、点、斜杠、冒号、等号和空格

        Args:
            args: 用户输入的自定义参数字符串

        Returns:
            tuple[bool, str]: (是否有效, 错误信息)
        """
        if not args or not args.strip():
            return True, ""

        # 检查危险的 shell 元字符（命令注入特征）
        dangerous_chars = ["|", "&", ";", "$", "`", "(", ")", "<", ">", "\n", "\r"]
        for char in dangerous_chars:
            if char in args:
                return False, f"参数包含危险字符: '{char}'。请勿使用 shell 命令语法。"

        # 检查引号是否配对
        single_quotes = args.count("'")
        double_quotes = args.count('"')
        if single_quotes % 2 != 0 or double_quotes % 2 != 0:
            return False, "参数包含未闭合的引号"

        # 使用正则表达式验证参数格式
        # 允许的格式：
        # - --flag
        # - --key=value
        # - -k
        # - -k value
        # - --key "value with spaces"
        # 路径允许: /, \, :, .（如 --path=C:/path or --port=8080）

        # 分割参数并逐个验证
        try:
            # 使用 shlex 安全分割参数（保留引号内的空格）
            import shlex

            parts = shlex.split(args, posix=False)
        except ValueError as e:
            return False, f"参数格式错误: {str(e)}"

        for part in parts:
            # 允许的字符：字母、数字、下划线、短横线、点、斜杠、冒号、等号、冒号
            # 也允许中文等 Unicode 字符
            # 使用更宽松的正则表达式，同时排除危险模式
            if not re.match(r"^[\w\-=/:\\.,@%+]+$", part):
                return False, f"参数包含非法字符: '{part}'"

        return True, ""

    def envCheck(self):
        if os.path.exists(os.path.join(os.getcwd(), "env\\")):
            return False
        else:
            return True

    def hide_window(self):
        """仅隐藏窗口（用于启用托盘时的窗口关闭）"""
        if self.page is not None:
            try:
                self.page.window.visible = False
                self.page.update()
            except (AssertionError, AttributeError, RuntimeError):
                # RuntimeError: session 可能已被销毁
                pass

    def open_window(self):
        """仅打开窗口（用于启用托盘时的窗口打开）"""
        if self.page is not None:
            try:
                self.page.window.visible = True
                self.page.update()

                # to_front() 是异步方法，需要使用 run_task 调度
                async def bring_to_front():
                    try:
                        if self.page and self.page.window:
                            await self.page.window.to_front()
                    except (RuntimeError, AttributeError):
                        pass

                self.page.run_task(bring_to_front)
            except (AssertionError, AttributeError, RuntimeError):
                # RuntimeError: session 可能已被销毁
                pass

    def _hide_window_sync(self):
        """
        同步隐藏窗口（用于立即用户反馈）

        此方法在退出流程中最先调用，确保窗口立即从屏幕上消失
        """
        if self.page is not None:
            try:
                self.page.window.visible = False
                self.page.window.prevent_close = False
                self.page.update()
                app_logger.info("窗口已隐藏")
            except (AssertionError, AttributeError, RuntimeError) as e:
                app_logger.warning(f"隐藏窗口时出错: {e}")

    async def _close_and_destroy_window_async(self):
        """
        异步关闭并销毁窗口

        此方法在进程停止后调用，负责优雅地关闭窗口
        """
        try:
            if self.page and self.page.window:
                # 先尝试正常关闭窗口
                try:
                    await self.page.window.close()
                    app_logger.info("窗口已关闭")
                except (RuntimeError, AttributeError):
                    # 关闭失败时，强制销毁窗口
                    app_logger.warning("窗口关闭失败，尝试强制销毁")
                    await self.page.window.destroy()
                    app_logger.info("窗口已强制销毁")
        except (RuntimeError, AttributeError) as e:
            app_logger.warning(f"销毁窗口时出错: {e}")

    def _exit_app_full(self, stop_processes=True):
        """
        完全退出应用程序的内部实现

        Args:
            stop_processes: 是否停止进程（默认True）

        执行以下操作：
        1. 立即隐藏窗口（同步，用户体验优先）
        2. 停止所有运行的进程（可选）
        3. 异步关闭并销毁窗口
        """
        # ========== 1. 立即隐藏窗口（同步操作，保证用户体验） ==========
        self._hide_window_sync()

        # ========== 2 & 3. 停止所有运行的进程（可选）然后销毁窗口 ==========
        if self.page is not None:
            try:

                async def stop_and_destroy():
                    """先停止进程，再销毁窗口"""
                    # 2. 停止所有运行的进程（可选）
                    if stop_processes and self.terminal and self.terminal.is_running:
                        try:
                            await self.terminal.stop_processes()
                            app_logger.info("进程已停止")
                        except Exception as ex:
                            app_logger.exception("停止进程时出错")
                    # 3. 销毁窗口
                    await self._close_and_destroy_window_async()

                self.page.run_task(stop_and_destroy)
            except (AttributeError, RuntimeError):
                # page 可能已不可用
                pass

    def exit_app(self, e):
        """
        退出应用程序（窗口关闭时调用）

        根据是否启用托盘决定行为：
        - 如果启用托盘：仅隐藏窗口，不停止进程
        - 如果未启用托盘：完全退出程序

        设计说明：
        - 窗口关闭按钮（X）和 Alt+F4 会触发此方法
        - 只有未启用托盘时才会真正退出程序
        """
        use_tray = (
            self.config_manager.get("tray", True) if self.config_manager else True
        )
        tray_exists = self.tray is not None

        if use_tray and tray_exists:
            # 启用托盘时：仅隐藏窗口
            app_logger.info("启用托盘模式，隐藏窗口而不退出")
            self.hide_window()
        else:
            # 未启用托盘时：完全退出程序
            app_logger.info("未启用托盘模式，执行完全退出")
            self._exit_app_full()

    def exit_app_with_tray(self, e):
        """
        通过托盘退出应用程序

        此方法仅从托盘菜单的"退出启动器"选项调用，负责停止运行进程
        和关闭应用窗口。托盘本身已在 Tray.exit_app() 中停止。

        Args:
            e: 事件对象，用于触发退出操作（未使用）

        Note:
            - 立即隐藏窗口（同步）
            - 停止所有正在运行的进程（同步方式）
            - 异步销毁窗口
            - 托盘图标已在 Tray.exit_app() 中停止
        """
        app_logger.info("通过托盘退出应用程序")

        # ========== 1. 立即隐藏窗口（同步，用户体验优先） ==========
        self._hide_window_sync()

        # ========== 2. 停止所有运行的进程（同步方法）==========
        if self.terminal and self.terminal.is_running:
            try:
                self.terminal.stop_processes_sync()
                app_logger.info("进程已停止")
            except Exception as e:
                app_logger.exception("停止进程时出错")

        # ========== 3. 异步销毁窗口 ==========
        if self.page is not None:
            try:
                self.page.run_task(self._close_and_destroy_window_async)
            except (AttributeError, RuntimeError):
                pass

    def cleanup(self):
        """清理所有资源引用，打破循环引用"""
        try:
            app_logger.info("UIEvent cleaning up resources...")

            # 1. 断开与 UniUI 的引用（打破循环引用）
            if self.uni_ui is not None:
                self.uni_ui = None

            # 2. 清理 page 引用
            if hasattr(self, "page") and self.page is not None:
                self.page = None

            # 3. 清理 terminal 引用
            if hasattr(self, "terminal") and self.terminal is not None:
                self.terminal = None

            # 4. 清理其他引用
            if hasattr(self, "env") and self.env is not None:
                self.env = None
            if hasattr(self, "stCfg") and self.stCfg is not None:
                self.stCfg = None
            if hasattr(self, "config_manager") and self.config_manager is not None:
                self.config_manager = None
            if hasattr(self, "tray") and self.tray is not None:
                self.tray = None

            app_logger.info("UIEvent resources cleaned up")
        except Exception as e:
            app_logger.exception("UIEvent cleanup error")

    def __del__(self):
        """析构函数 - 确保资源释放"""
        try:
            self.cleanup()
        except Exception as e:
            # __del__ 中避免使用 logger，防止模块已卸载导致错误
            pass

    def switch_theme(self, e):
        try:
            # 验证事件和控制对象
            if e is None or e.control is None:
                app_logger.warning("switch_theme: 事件对象或控制对象为空")
                return

            # 获取正确的图标常量
            from flet import Icons

            if self.page.theme_mode == "light":
                e.control.icon = Icons.SUNNY
                self.page.theme_mode = "dark"
                self.config_manager.set("theme", "dark")
            else:
                e.control.icon = Icons.MODE_NIGHT
                self.page.theme_mode = "light"
                self.config_manager.set("theme", "light")

            # 保存配置
            self.config_manager.save_config()

            # 更新页面
            try:
                self.page.update()
            except AssertionError:
                # 控件树过深，尝试异步更新
                async def async_update():
                    try:
                        self.page.update()
                    except AssertionError:
                        pass  # 忽略控件树过深错误

                self.page.run_task(async_update)
            except Exception as update_error:
                app_logger.error(f"页面更新失败: {str(update_error)}")

        except Exception as ex:
            # 捕获并记录所有错误
            app_logger.exception(f"切换主题失败: {str(ex)}")

    def install_sillytavern(self, e):
        """安装SillyTavern"""
        try:
            # 验证路径是否适合NPM运行
            if not self.validate_path_for_npm():
                return

            git_path = self.env.get_git_path()
            if self.env.checkST():
                self.terminal.add_log("SillyTavern已安装")
                if self.env.get_node_path():
                    if self.env.check_nodemodules():
                        self.terminal.add_log("依赖项已安装")
                    else:
                        self.terminal.add_log("正在安装依赖...")

                        # 使用run_async_task处理异步任务
                        async def install_deps():
                            process = await self.execute_command(
                                f'"{self.env.get_node_path()}npm" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com',
                                "SillyTavern",
                            )
                            if process:
                                await process.wait()
                                self.terminal.add_log("依赖安装完成")

                        self.run_async_task(install_deps())
                else:
                    self.terminal.add_log("未找到nodejs")
            else:
                if git_path:
                    # 从配置获取镜像设置
                    mirror_type = self.config_manager.get("github.mirror", "github")

                    # 根据镜像设置选择仓库地址
                    if mirror_type == "github":
                        repo_url = "https://github.com/SillyTavern/SillyTavern.git"
                    else:
                        # 使用Gitee镜像
                        repo_url = "https://gitee.com/lingyesoul/SillyTavern.git"

                    self.terminal.add_log(f"正在从 {repo_url} 安装SillyTavern...")

                    # 使用run_async_task处理异步任务
                    async def install_st():
                        process = await self.execute_command(
                            f'"{git_path}git" clone {repo_url} -b release', "."
                        )
                        if process:
                            await process.wait()
                            self.terminal.add_log("SillyTavern安装完成")

                            # 检查Node.js环境并自动安装依赖
                            if self.env.get_node_path():
                                if self.env.check_nodemodules():
                                    self.terminal.add_log("依赖项已安装")
                                else:
                                    self.terminal.add_log("正在安装依赖...")
                                    # 安装npm依赖
                                    dep_process = await self.execute_command(
                                        f'"{self.env.get_node_path()}npm" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com',
                                        "SillyTavern",
                                    )
                                    if dep_process:
                                        await dep_process.wait()
                                        self.terminal.add_log("依赖安装完成")
                            else:
                                self.terminal.add_log("未找到nodejs")

                    self.run_async_task(install_st())
                else:
                    self.terminal.add_log("Error: Git路径未正确配置")
        except Exception as ex:
            error_msg = f"安装SillyTavern时出错: {str(ex)}"
            self.terminal.add_log(error_msg)
            app_logger.exception(error_msg)

    def validate_path_for_npm(self, path=None, show_success=True):
        """
        验证路径是否适合NPM运行

        Args:
            path (str, optional): 要验证的路径，默认为当前工作目录
            show_success (bool): 是否在验证通过时显示成功信息

        Returns:
            bool: True表示路径有效，False表示路径有问题
        """
        if path is None:
            path = os.getcwd()

        # 定义NPM不支持的字符集
        # 包括：中文、日文、韩文、空格、特殊符号等
        problematic_chars = {
            # 中文字符（CJK统一汉字）
            "\u4e00",
            "\u9fff",  # 中文范围
            # 日文字符
            "\u3040",
            "\u309f",  # 平假名
            "\u30a0",
            "\u30ff",  # 片假名
            # 韩文字符
            "\uac00",
            "\ud7af",  # 韩文音节
            # 空格和空白字符
            " ",
            "\t",
            "\n",
            "\r",
            # 特殊符号（Windows路径不支持或NPM容易出错的）
            "!",
            '"',
            "#",
            "$",
            "%",
            "&",
            "'",
            "(",
            ")",
            "*",
            "+",
            ",",
            ";",
            "<",
            "=",
            ">",
            "?",
            "@",
            "[",
            "]",
            "^",
            "`",
            "{",
            "|",
            "}",
            "~",
            "-",
            # 中文标点
            "，",
            "。",
            "！",
            "？",
            "；",
            "：",
            "（",
            "）",
            "【",
            "】",
            "、",
            "《",
            "》",
            '"',
            '"',
            """, """,
            "…",
            "——",
            # 全角字符
            "　",
            "！",
            "＂",
            "＃",
            "＄",
            "％",
            "＆",
            "＇",
            "（",
            "）",
            "＊",
            "＋",
            "，",
            "－",
            "．",
            "／",
            "：",
            "；",
            "＜",
            "＝",
            "＞",
            "？",
            "＠",
            "［",
            "＼",
            "］",
            "＾",
            "＿",
            "｀",
            "｛",
            "｜",
            "｝",
            "～",
        }

        # 检查路径中的每个字符
        found_problematic_chars = []
        for char in path:
            # 检查中文字符
            if "\u4e00" <= char <= "\u9fff":
                found_problematic_chars.append(f"中文字符 '{char}'")
            # 检查日文字符
            elif "\u3040" <= char <= "\u309f" or "\u30a0" <= char <= "\u30ff":
                found_problematic_chars.append(f"日文字符 '{char}'")
            # 检查韩文字符
            elif "\uac00" <= char <= "\ud7af":
                found_problematic_chars.append(f"韩文字符 '{char}'")
            # 检查其他特殊字符
            elif char in problematic_chars:
                char_type = "空格" if char == " " else f"特殊字符 '{char}'"
                found_problematic_chars.append(char_type)

        # 如果发现问题字符，显示详细错误信息
        if found_problematic_chars:
            error_msg = "错误：当前路径包含以下NPM不支持的字符：\n"
            # 去重并格式化错误信息
            unique_chars = list(set(found_problematic_chars))
            if len(unique_chars) <= 5:
                error_msg += "  " + "\n  ".join(unique_chars)
            else:
                error_msg += (
                    "  "
                    + "\n  ".join(unique_chars[:5])
                    + f"\n  ... 还有{len(unique_chars) - 5}个其他问题字符"
                )

            error_msg += f"\n\n当前路径：{path}"
            error_msg += "\n\n建议：请将程序移动到纯英文路径下（不包含空格和特殊字符）"
            self.terminal.add_log(error_msg)
            return False

        # 额外检查：确保路径是有效的ASCII路径
        try:
            # 尝试编码检查
            path.encode("ascii")
        except UnicodeEncodeError:
            self.terminal.add_log(
                f"错误：路径包含非ASCII字符，可能导致NPM运行失败\n当前路径：{path}"
            )
            return False

        # 检查路径长度（Windows路径限制）
        if len(path) > 250:
            self.terminal.add_log(
                f"警告：路径长度过长（{len(path)}字符），建议缩短路径以避免潜在问题"
            )

        # 检查是否为网络路径（UNC路径）
        if path.startswith("\\\\"):
            self.terminal.add_log("警告：检测到网络路径（UNC），可能影响NPM正常运行")

        # 检查是否包含非常规的驱动器路径（排除正常的Windows驱动器格式，如 C:）
        if len(path) > 2 and ":" in path[2:]:
            # 跳过正常的Windows驱动器路径（第二个字符及以后不应包含冒号）
            self.terminal.add_log(
                "警告：检测到非常规的驱动器路径格式，可能影响NPM正常运行"
            )

        if show_success:
            self.terminal.add_log(f"路径验证通过：{path}")

        return True

    def start_sillytavern(self, e):
        """启动SillyTavern"""
        try:
            # 立即输出提示信息
            self.terminal.add_log("正在启动SillyTavern...")

            # 验证路径是否适合NPM运行
            if not self.validate_path_for_npm():
                return

            # 检查是否开启了自动代理设置
            auto_proxy = self.config_manager.get("auto_proxy", False)
            if auto_proxy:
                try:
                    # 获取系统代理设置
                    proxies = urllib.request.getproxies()
                    self.terminal.add_log(f"检测到的系统代理: {proxies}")

                    # 查找HTTP或SOCKS代理
                    proxy_url = ""
                    if "http" in proxies:
                        proxy_url = proxies["http"]
                    elif "https" in proxies:
                        proxy_url = proxies["https"]
                    elif "socks" in proxies:
                        proxy_url = proxies["socks"]
                    elif "socks5" in proxies:
                        proxy_url = proxies["socks5"]

                    # 如果没有可用的系统代理，则关闭请求代理
                    if not proxy_url:
                        self.stCfg.proxy_enabled = False
                        self.stCfg.save_config()
                        self.terminal.add_log(
                            "未检测到有效的系统代理，已自动关闭请求代理"
                        )
                    else:
                        # 启用代理
                        self.stCfg.proxy_enabled = True
                        # 设置代理URL
                        self.stCfg.proxy_url = proxy_url
                        # 保存配置
                        self.stCfg.save_config()
                        self.terminal.add_log(f"自动设置代理: {proxy_url}")
                except Exception as ex:
                    self.terminal.add_log(f"自动检测代理时出错: {str(ex)}")

            if self.terminal.is_running:
                self.terminal.add_log("SillyTavern已经在运行中")
                return

            if self.env.checkST():
                if self.env.check_nodemodules():
                    self.terminal.is_running = True
                    self.terminal.add_log("✓ SillyTavern启动成功")

                    async def on_process_exit():
                        self.terminal.is_running = False
                        self.terminal.add_log("SillyTavern进程已退出")

                    # 同步版本（用于fallback）
                    def on_process_exit_sync():
                        self.terminal.is_running = False
                        self.terminal.add_log("SillyTavern进程已退出")

                    # 启动进程并设置退出回调
                    custom_args = self.config_manager.get("custom_args", "")

                    # 验证自定义参数的安全性（防御性编程）
                    if custom_args:
                        is_valid, error_msg = self.validate_custom_args(custom_args)
                        if not is_valid:
                            self.terminal.add_log(
                                f"警告：自定义启动参数不安全，已忽略: {error_msg}"
                            )
                            custom_args = ""

                    use_optimize_args = self.config_manager.get(
                        "use_optimize_args", False
                    )
                    base_command = f'"{self.env.get_node_path()}node.exe" server.js'
                    if use_optimize_args:
                        base_command += " --max-old-space-size=4096"
                    if custom_args:
                        command = f"{base_command} {custom_args}"
                    else:
                        command = base_command

                    # 使用异步方式执行命令
                    async def start_st():
                        process = await self.execute_command(command, "SillyTavern")
                        if process:
                            # 等待进程完成
                            await process.wait()
                            # 在主线程中执行回调
                            try:
                                self.page.run_task(on_process_exit)
                            except AttributeError:
                                # Fallback for older versions of flet: 使用同步版本
                                on_process_exit_sync()

                    self.run_async_task(start_st())
                else:
                    self.terminal.add_log("依赖未安装，请先安装依赖")
            else:
                self.terminal.add_log("SillyTavern未安装，请先安装SillyTavern")
        except Exception as ex:
            error_msg = f"启动SillyTavern时出错: {str(ex)}"
            self.terminal.add_log(error_msg)
            app_logger.exception(error_msg)

    def stop_sillytavern(self, e):
        """
        停止SillyTavern
        """
        try:
            self.terminal.add_log("正在检查进程状态...")

            # 检查是否有活跃的进程
            if not self.terminal.active_processes:
                self.terminal.add_log("当前没有运行中的进程")
                return

            # 获取进程数量
            process_count = len(self.terminal.active_processes)
            self.terminal.add_log(f"检测到 {process_count} 个运行中的进程")
            self.terminal.add_log("正在停止SillyTavern进程...")

            # ========== 异步停止进程 ==========
            async def stop_and_restore():
                try:
                    await self.terminal.stop_processes()
                    self.terminal.add_log("✓ 所有进程已停止")
                except Exception as ex:
                    self.terminal.add_log(f"停止进程时出错: {str(ex)}")

            self.page.run_task(stop_and_restore)

        except Exception as ex:
            error_msg = f"停止进程时出错: {str(ex)}"
            self.terminal.add_log(error_msg)
            app_logger.exception(error_msg)

    def restart_sillytavern(self, e):
        """
        重启SillyTavern服务

        改进说明：
        - 正确处理 terminal.stop_processes() 的异步特性
        - 等待停止完成后再启动
        """
        self.terminal.add_log("正在重启SillyTavern...")

        # ========== 异步停止服务 ==========
        async def stop_and_start():
            try:
                await self.terminal.stop_processes()
                self.terminal.add_log("旧进程已停止")

                # 检查路径是否包含中文或空格
                current_path = os.getcwd()

                # 检查是否包含中文字符（使用Python内置方法）
                has_chinese = any("\u4e00" <= char <= "\u9fff" for char in current_path)
                if has_chinese:
                    self.terminal.add_log(
                        "错误：路径包含中文字符，请将程序移动到不包含中文字符的路径下运行"
                    )
                    return

                # 检查是否包含空格
                if " " in current_path:
                    self.terminal.add_log(
                        "错误：路径包含空格，请将程序移动到不包含空格的路径下运行"
                    )
                    return

                if self.env.checkST():
                    if self.env.check_nodemodules():
                        self.terminal.is_running = True

                        # 同步版本（在线程中使用）
                        def on_process_exit_sync():
                            self.terminal.is_running = False
                            self.terminal.add_log("SillyTavern进程已退出")

                        # 启动进程并设置退出回调
                        custom_args = self.config_manager.get("custom_args", "")

                        # 验证自定义参数的安全性（防御性编程）
                        if custom_args:
                            is_valid, error_msg = self.validate_custom_args(custom_args)
                            if not is_valid:
                                self.terminal.add_log(
                                    f"警告：自定义启动参数不安全，已忽略: {error_msg}"
                                )
                                custom_args = ""

                        use_optimize_args = self.config_manager.get(
                            "use_optimize_args", False
                        )
                        base_command = f'"{self.env.get_node_path()}node" server.js'
                        if use_optimize_args:
                            base_command += " --max-old-space-size=4096"
                        if custom_args:
                            command = f"{base_command} {custom_args}"
                        else:
                            command = base_command

                        process = self.execute_command(command, "SillyTavern")
                        if process:

                            def wait_for_exit():
                                # 创建一个新的事件循环并运行直到完成
                                loop = asyncio.new_event_loop()
                                asyncio.set_event_loop(loop)
                                try:
                                    # 如果process是一个协程对象，我们需要运行它直到完成以获取进程对象
                                    if asyncio.iscoroutine(process):
                                        process_obj = loop.run_until_complete(process)
                                    else:
                                        process_obj = process

                                    # 等待进程完成
                                    loop.run_until_complete(process_obj.wait())
                                finally:
                                    loop.close()
                                # 使用同步版本
                                on_process_exit_sync()

                            threading.Thread(target=wait_for_exit, daemon=True).start()
                            self.terminal.add_log("SillyTavern已重启")
                        else:
                            self.terminal.add_log("重启失败")
                    else:
                        self.terminal.add_log("依赖项未安装")
                else:
                    self.terminal.add_log("SillyTavern未安装")
            except Exception as ex:
                self.terminal.add_log(f"重启失败: {str(ex)}")
                import traceback

                traceback.print_exc()

        self.page.run_task(stop_and_start)

    def clear_terminal(self, e):
        """
        清空终端内容（UI事件处理层）

        职责说明：
        - 这是UI事件处理层，负责将按钮点击事件转发到 terminal 层
        - 实际的清空逻辑在 terminal.clear_terminal() 中实现
        """
        self.terminal.clear_terminal()

    def update_sillytavern(self, e):
        """更新SillyTavern"""
        try:
            # 验证路径是否适合NPM运行
            if not self.validate_path_for_npm():
                return

            git_path = self.env.get_git_path()
            if self.env.checkST():
                self.terminal.add_log("正在更新SillyTavern...")
                if git_path:
                    # 检查并恢复detached HEAD状态
                    self.terminal.add_log("检查Git状态...")
                    try:
                        # 检查是否处于detached HEAD状态
                        branch_check = subprocess.run(
                            f'"{git_path}git" rev-parse --abbrev-ref HEAD',
                            shell=True,
                            capture_output=True,
                            text=True,
                            cwd=self.env.st_dir,
                            creationflags=subprocess.CREATE_NO_WINDOW,
                        )

                        if branch_check.returncode == 0:
                            current_branch = branch_check.stdout.strip()
                            # 如果输出是"HEAD"，说明处于detached状态
                            if current_branch == "HEAD":
                                self.terminal.add_log(
                                    "检测到detached HEAD状态，正在切换到release分支..."
                                )

                                # 先尝试本地checkout，如果失败则从远程创建
                                checkout_result = subprocess.run(
                                    f'"{git_path}git" checkout -B release origin/release',
                                    shell=True,
                                    capture_output=True,
                                    text=True,
                                    cwd=self.env.st_dir,
                                    creationflags=subprocess.CREATE_NO_WINDOW,
                                )

                                if checkout_result.returncode == 0:
                                    self.terminal.add_log("成功切换到release分支")
                                else:
                                    # 尝试更简单的恢复方式
                                    self.terminal.add_log("尝试另一种恢复方式...")
                                    checkout_result2 = subprocess.run(
                                        f'"{git_path}git" checkout release',
                                        shell=True,
                                        capture_output=True,
                                        text=True,
                                        cwd=self.env.st_dir,
                                        creationflags=subprocess.CREATE_NO_WINDOW,
                                    )

                                    if checkout_result2.returncode == 0:
                                        self.terminal.add_log("成功切换到release分支")
                                    else:
                                        self.terminal.add_log(
                                            "切换到release分支失败，请手动处理"
                                        )
                                        return
                    except Exception as ex:
                        self.terminal.add_log(f"检查detached HEAD状态时出错: {str(ex)}")

                    # 检查当前远程仓库地址是否正确
                    mirror_type = self.config_manager.get("github.mirror", "github")

                    # 确保远程仓库地址正确
                    if mirror_type == "github":
                        expected_remote = (
                            "https://github.com/SillyTavern/SillyTavern.git"
                        )
                    else:
                        expected_remote = "https://gitee.com/lingyesoul/SillyTavern.git"

                    try:
                        # 获取当前远程仓库地址
                        current_remote_process = subprocess.run(
                            f'"{git_path}git" remote get-url origin',
                            shell=True,
                            capture_output=True,
                            text=True,
                            cwd=self.env.st_dir,
                            creationflags=subprocess.CREATE_NO_WINDOW,
                        )

                        if current_remote_process.returncode == 0:
                            current_remote = current_remote_process.stdout.strip()
                            if current_remote != expected_remote:
                                # 更新远程仓库地址
                                self.terminal.add_log(
                                    f"更新远程仓库地址: {expected_remote}"
                                )
                                subprocess.run(
                                    f'"{git_path}git" remote set-url origin {expected_remote}',
                                    shell=True,
                                    cwd=self.env.st_dir,
                                    creationflags=subprocess.CREATE_NO_WINDOW,
                                )
                    except Exception as ex:
                        self.terminal.add_log(f"检查/更新远程仓库地址时出错: {str(ex)}")

                    # 执行git pull
                    def on_git_complete(process):
                        if process.returncode == 0:
                            self.terminal.add_log("Git更新成功")
                            if self.env.get_node_path():
                                self.terminal.add_log("正在安装依赖...")

                                def on_npm_complete(process):
                                    if process.returncode == 0:
                                        self.terminal.add_log("依赖安装成功")
                                    else:
                                        self.terminal.add_log("依赖安装失败")

                                # 使用异步方式执行npm install
                                async def install_deps():
                                    process = await self.execute_command(
                                        f'"{self.env.get_node_path()}npm" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com',
                                        "SillyTavern",
                                    )
                                    if process:
                                        await process.wait()
                                        on_npm_complete(process)

                                self.run_async_task(install_deps())
                            else:
                                self.terminal.add_log("未找到nodejs")
                        else:
                            # 检查是否是由于package-lock.json冲突导致的更新失败
                            self.terminal.add_log(
                                "Git更新失败，检查是否为package-lock.json冲突..."
                            )
                            try:
                                # 尝试解决package-lock.json冲突
                                reset_process = subprocess.run(
                                    f'"{git_path}git" checkout -- package-lock.json',
                                    shell=True,
                                    cwd=self.env.st_dir,
                                    creationflags=subprocess.CREATE_NO_WINDOW,
                                    capture_output=True,
                                    text=True,
                                )

                                if reset_process.returncode == 0:
                                    self.terminal.add_log(
                                        "已重置package-lock.json，重新尝试更新..."
                                    )

                                    # 重新执行git pull
                                    async def retry_update():
                                        retry_process = await self.execute_command(
                                            f'"{git_path}git" pull --rebase --autostash',
                                            "SillyTavern",
                                        )
                                        if retry_process:
                                            await retry_process.wait()
                                            # 避免递归调用，直接处理结果
                                            if retry_process.returncode == 0:
                                                self.terminal.add_log("Git更新成功")
                                                if self.env.get_node_path():
                                                    self.terminal.add_log(
                                                        "正在安装依赖..."
                                                    )

                                                    def on_npm_complete(process):
                                                        if process.returncode == 0:
                                                            self.terminal.add_log(
                                                                "依赖安装成功"
                                                            )
                                                        else:
                                                            self.terminal.add_log(
                                                                "依赖安装失败"
                                                            )

                                                    async def install_deps():
                                                        process = await self.execute_command(
                                                            f'"{self.env.get_node_path()}npm" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com',
                                                            "SillyTavern",
                                                        )
                                                        if process:
                                                            await process.wait()
                                                            on_npm_complete(process)

                                                    self.run_async_task(install_deps())
                                                else:
                                                    self.terminal.add_log(
                                                        "未找到nodejs"
                                                    )
                                            else:
                                                self.terminal.add_log("重试更新失败")

                                    self.run_async_task(retry_update())
                                else:
                                    self.terminal.add_log(
                                        "无法解决package-lock.json冲突，需要手动处理"
                                    )
                            except Exception as ex:
                                self.terminal.add_log(
                                    f"处理package-lock.json冲突时出错: {str(ex)}"
                                )

                    # 使用异步方式执行git pull
                    async def git_pull():
                        process = await self.execute_command(
                            f'"{git_path}git" pull --rebase --autostash', "SillyTavern"
                        )
                        if process:
                            await process.wait()
                            on_git_complete(process)

                    self.run_async_task(git_pull())
                else:
                    self.terminal.add_log("未找到Git路径，请手动更新SillyTavern")
            else:
                self.terminal.add_log("SillyTavern未安装")
        except Exception as ex:
            error_msg = f"更新SillyTavern时出错: {str(ex)}"
            self.terminal.add_log(error_msg)
            app_logger.exception(error_msg)

    def update_sillytavern_with_callback(self, e):
        """
        更新SillyTavern并在完成后自动启动
        """
        try:
            # 验证路径是否适合NPM运行
            if not self.validate_path_for_npm():
                return

            git_path = self.env.get_git_path()
            if self.env.checkST():
                self.terminal.add_log("正在更新SillyTavern...")
                if git_path:
                    # 检查并恢复detached HEAD状态
                    self.terminal.add_log("检查Git状态...")
                    try:
                        # 检查是否处于detached HEAD状态
                        branch_check = subprocess.run(
                            f'"{git_path}git" rev-parse --abbrev-ref HEAD',
                            shell=True,
                            capture_output=True,
                            text=True,
                            cwd=self.env.st_dir,
                            creationflags=subprocess.CREATE_NO_WINDOW,
                        )

                        if branch_check.returncode == 0:
                            current_branch = branch_check.stdout.strip()
                            # 如果输出是"HEAD"，说明处于detached状态
                            if current_branch == "HEAD":
                                self.terminal.add_log(
                                    "检测到detached HEAD状态，正在切换到release分支..."
                                )

                                # 先尝试本地checkout，如果失败则从远程创建
                                checkout_result = subprocess.run(
                                    f'"{git_path}git" checkout -B release origin/release',
                                    shell=True,
                                    capture_output=True,
                                    text=True,
                                    cwd=self.env.st_dir,
                                    creationflags=subprocess.CREATE_NO_WINDOW,
                                )

                                if checkout_result.returncode == 0:
                                    self.terminal.add_log("成功切换到release分支")
                                else:
                                    # 尝试更简单的恢复方式
                                    self.terminal.add_log("尝试另一种恢复方式...")
                                    checkout_result2 = subprocess.run(
                                        f'"{git_path}git" checkout release',
                                        shell=True,
                                        capture_output=True,
                                        text=True,
                                        cwd=self.env.st_dir,
                                        creationflags=subprocess.CREATE_NO_WINDOW,
                                    )

                                    if checkout_result2.returncode == 0:
                                        self.terminal.add_log("成功切换到release分支")
                                    else:
                                        self.terminal.add_log(
                                            "切换到release分支失败，请手动处理"
                                        )
                                        return
                    except Exception as ex:
                        self.terminal.add_log(f"检查detached HEAD状态时出错: {str(ex)}")

                    # 执行git pull
                    def on_git_complete(process, retry_count=0):
                        if process.returncode == 0:
                            self.terminal.add_log("Git更新成功")
                            if self.env.get_node_path():
                                self.terminal.add_log("正在安装依赖...")

                                def on_npm_complete(process, npm_retry_count=0):
                                    if process.returncode == 0:
                                        self.terminal.add_log(
                                            "依赖安装成功，正在启动SillyTavern..."
                                        )
                                        self.start_sillytavern(None)
                                    else:
                                        if npm_retry_count < 2:
                                            self.terminal.add_log(
                                                f"依赖安装失败，正在重试... (尝试次数: {npm_retry_count + 1}/2)"
                                            )

                                            # 清理npm缓存
                                            async def clean_cache():
                                                cache_process = await self.execute_command(
                                                    f'"{self.env.get_node_path()}npm" cache clean --force',
                                                    "SillyTavern",
                                                )
                                                if cache_process:
                                                    await cache_process.wait()
                                                    # 删除node_modules
                                                    node_modules_path = os.path.join(
                                                        self.env.st_dir, "node_modules"
                                                    )
                                                    if os.path.exists(
                                                        node_modules_path
                                                    ):
                                                        try:
                                                            import shutil

                                                            shutil.rmtree(
                                                                node_modules_path
                                                            )
                                                        except Exception as ex:
                                                            self.terminal.add_log(
                                                                f"删除node_modules失败: {str(ex)}"
                                                            )

                                                    # 重新安装依赖
                                                    async def retry_install():
                                                        retry_process = await self.execute_command(
                                                            f'"{self.env.get_node_path()}npm" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com',
                                                            "SillyTavern",
                                                        )
                                                        if retry_process:
                                                            await retry_process.wait()
                                                            # 在主线程中调用回调
                                                            try:
                                                                self.page.run_task(
                                                                    lambda: on_npm_complete(
                                                                        retry_process,
                                                                        npm_retry_count
                                                                        + 1,
                                                                    )
                                                                )
                                                            except AttributeError:
                                                                on_npm_complete(
                                                                    retry_process,
                                                                    npm_retry_count + 1,
                                                                )

                                                    self.run_async_task(retry_install())

                                            self.run_async_task(clean_cache())
                                        else:
                                            self.terminal.add_log(
                                                "依赖安装失败，正在启动SillyTavern..."
                                            )
                                            self.start_sillytavern(None)

                                async def install_deps():
                                    process = await self.execute_command(
                                        f'"{self.env.get_node_path()}npm" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com',
                                        "SillyTavern",
                                    )
                                    if process:
                                        await process.wait()
                                        # 在主线程中调用回调
                                        try:
                                            self.page.run_task(
                                                lambda: on_npm_complete(process, 0)
                                            )
                                        except AttributeError:
                                            on_npm_complete(process, 0)

                                self.run_async_task(install_deps())
                            else:
                                self.terminal.add_log(
                                    "未找到nodejs，正在启动SillyTavern..."
                                )
                                self.start_sillytavern(None)
                        else:
                            # 检查重试次数，避免无限重试
                            if retry_count < 2:
                                self.terminal.add_log(
                                    f"Git更新失败，检查是否为package-lock.json冲突... (尝试次数: {retry_count + 1}/2)"
                                )
                                try:
                                    # 尝试解决package-lock.json冲突
                                    reset_process = subprocess.run(
                                        f'"{git_path}git" checkout -- package-lock.json',
                                        shell=True,
                                        cwd=self.env.st_dir,
                                        creationflags=subprocess.CREATE_NO_WINDOW,
                                        capture_output=True,
                                        text=True,
                                    )

                                    if reset_process.returncode == 0:
                                        self.terminal.add_log(
                                            "已重置package-lock.json，重新尝试更新..."
                                        )

                                        # 重新执行git pull
                                        async def retry_update():
                                            retry_process = await self.execute_command(
                                                f'"{git_path}git" pull --rebase --autostash',
                                                "SillyTavern",
                                            )
                                            if retry_process:
                                                await retry_process.wait()
                                                # 避免递归调用，直接处理结果
                                                # 在主线程中调用回调
                                                try:
                                                    self.page.run_task(
                                                        lambda: on_git_complete(
                                                            retry_process,
                                                            retry_count + 1,
                                                        )
                                                    )
                                                except AttributeError:
                                                    on_git_complete(
                                                        retry_process, retry_count + 1
                                                    )

                                        self.run_async_task(retry_update())
                                    else:
                                        self.terminal.add_log(
                                            "无法解决package-lock.json冲突，需要手动处理"
                                        )
                                except Exception as ex:
                                    self.terminal.add_log(
                                        f"处理package-lock.json冲突时出错: {str(ex)}"
                                    )
                            else:
                                self.terminal.add_log(
                                    "Git更新失败，正在启动SillyTavern..."
                                )
                                self.start_sillytavern(None)

                    async def git_pull():
                        process = await self.execute_command(
                            f'"{git_path}git" pull --rebase --autostash', "SillyTavern"
                        )
                        if process:
                            await process.wait()
                            # 在主线程中调用回调
                            try:
                                self.page.run_task(lambda: on_git_complete(process, 0))
                            except AttributeError:
                                on_git_complete(process, 0)

                    self.run_async_task(git_pull())
                else:
                    self.terminal.add_log("未找到Git路径，请手动更新SillyTavern")
            else:
                self.terminal.add_log("SillyTavern未安装")
        except Exception as ex:
            error_msg = f"更新SillyTavern时出错: {str(ex)}"
            self.terminal.add_log(error_msg)
            app_logger.exception(error_msg)

    def port_changed(self, e):
        self.stCfg.port = e.control.value
        self.stCfg.save_config()
        self.showMsg("配置文件已保存")

    def listen_changed(self, e):
        self.stCfg.listen = e.control.value
        if self.stCfg.listen:
            if not self.stCfg.create_whitelist():
                self.show_error_dialog(
                    "白名单创建失败", "无法创建白名单文件，请检查日志"
                )
                self.stCfg.listen = False
                e.control.value = False
                e.control.update()
                return
        self.stCfg.save_config()
        self.showMsg("配置文件已保存")

    def auto_proxy_changed(self, e):
        """处理自动代理设置开关变化事件"""
        auto_proxy = e.control.value
        self.config_manager.set("auto_proxy", auto_proxy)
        self.config_manager.save_config()

        if auto_proxy:
            # 启用自动代理时，自动检测并设置代理
            self.auto_detect_and_set_proxy()

        self.showMsg("自动代理设置已更新")

    def auto_detect_and_set_proxy(self):
        """自动检测系统代理并设置"""
        try:
            # 获取系统代理设置
            proxies = urllib.request.getproxies()
            self.terminal.add_log(f"检测到的系统代理: {proxies}")

            # 查找HTTP或SOCKS代理
            proxy_url = ""
            if "http" in proxies:
                proxy_url = proxies["http"]
            elif "https" in proxies:
                proxy_url = proxies["https"]
            elif "socks" in proxies:
                proxy_url = proxies["socks"]
            elif "socks5" in proxies:
                proxy_url = proxies["socks5"]

            if proxy_url:
                # 启用代理
                self.stCfg.proxy_enabled = True

                # 设置代理URL
                self.stCfg.proxy_url = proxy_url

                # 保存配置
                self.stCfg.save_config()

                # 更新UI中的代理URL字段（如果可以访问）
                try:
                    # 尝试更新UI中的代理URL字段
                    if hasattr(self, "page") and self.page:
                        # 通过页面会话获取UI实例并更新代理URL字段
                        self.page.session.set("proxy_url", proxy_url)
                except:
                    pass

                self.terminal.add_log(f"自动设置代理: {proxy_url}")
                self.showMsg(f"已自动设置代理: {proxy_url}")
            else:
                self.terminal.add_log("未检测到有效的系统代理")
                self.showMsg("未检测到有效的系统代理")

        except Exception as e:
            self.terminal.add_log(f"自动检测代理时出错: {str(e)}")
            self.showMsg(f"自动检测代理失败: {str(e)}")

    def proxy_url_changed(self, e):
        self.stCfg.proxy_url = e.control.value
        self.stCfg.save_config()
        self.showMsg("配置文件已保存")

    def proxy_changed(self, e):
        self.stCfg.proxy_enabled = e.control.value
        self.stCfg.save_config()
        self.showMsg("配置文件已保存")

    def host_whitelist_changed(self, e):
        self.stCfg.host_whitelist_enabled = e.control.value
        self.stCfg.save_config()
        status = "开启" if self.stCfg.host_whitelist_enabled else "关闭"
        self.showMsg(f"主机白名单已{status}")

    def unified_whitelist_changed(self, e):
        self.stCfg.unified_whitelist = e.control.value
        if self.stCfg.unified_whitelist:
            self.stCfg.sync_whitelists("ip")
            self.showMsg("已启用统一白名单，IP 白名单已同步到主机白名单")
        else:
            self.stCfg.save_config()
            self.showMsg("已关闭统一白名单")

    def edit_host_whitelist(self, e):
        from ui.dialogs.host_whitelist_dialog import show_host_whitelist_dialog

        def on_save(scan, hosts):
            self.stCfg.host_whitelist_scan = scan
            self.stCfg.host_whitelist_hosts = hosts
            if self.stCfg.unified_whitelist:
                self.stCfg.sync_whitelists("host")
            else:
                self.stCfg.save_config()
            enabled = self.stCfg.host_whitelist_enabled
            status = "开启" if enabled else "关闭"
            self.showMsg(
                f"主机白名单配置已更新：{status}, 记录未受信任主机请求: {'开启' if scan else '关闭'}, 主机数: {len(hosts)}"
            )

        show_host_whitelist_dialog(self.page, self.stCfg, on_save)

    def edit_ip_whitelist(self, e):
        from ui.dialogs.ip_whitelist_dialog import show_ip_whitelist_dialog

        def on_save(mode, forwarded, ips):
            self.stCfg.whitelist_mode = mode
            self.stCfg.enable_forwarded_whitelist = forwarded
            self.stCfg.whitelist_ips = ips
            if self.stCfg.unified_whitelist:
                self.stCfg.sync_whitelists("ip")
            else:
                self.stCfg.save_config()
            self.showMsg(
                f"IP白名单配置已更新：过滤{'开启' if mode else '关闭'}, IP数: {len(ips)}"
            )

        show_ip_whitelist_dialog(self.page, self.stCfg, on_save)

    def env_changed(self, e):
        use_sys_env = e.control.value
        self.config_manager.set("use_sys_env", use_sys_env)
        if use_sys_env:
            self.env = SysEnv()
        else:
            self.env = Env()

        # 保存配置
        self.config_manager.save_config()
        self.showMsg("环境设置已保存")

    def patchgit_changed(self, e):
        patchgit = e.control.value
        self.config_manager.set("patchgit", patchgit)
        # 保存配置
        self.config_manager.save_config()
        self.showMsg("设置已保存")

    def sys_env_check(self, e):
        sysenv = SysEnv()
        tmp = sysenv.checkSysEnv()
        if tmp == True:
            self.showMsg(
                f"{tmp} Git：{sysenv.get_git_path()} NodeJS：{sysenv.get_node_path()}"
            )
        else:
            self.showMsg(f"{tmp}")

    def in_env_check(self, e):
        inenv = Env()
        tmp = inenv.checkEnv()
        if tmp == True:
            self.showMsg(
                f"{tmp} Git：{inenv.get_git_path()} NodeJS：{inenv.get_node_path()}"
            )
        else:
            self.showMsg(f"{tmp}")

    def checkupdate_changed(self, e):
        """
        处理自动检查更新设置变更
        """
        checkupdate = e.control.value
        self.config_manager.set("checkupdate", checkupdate)
        # 保存配置
        self.config_manager.save_config()
        self.showMsg("设置已保存")

    def stcheckupdate_changed(self, e):
        """
        处理酒馆自动检查更新设置变更
        """
        checkupdate = e.control.value
        self.config_manager.set("stcheckupdate", checkupdate)
        # 保存配置
        self.config_manager.save_config()
        self.showMsg("设置已保存")

    def showMsg(self, msg):
        # 使用正确的 API 显示 SnackBar（适配 Flet 0.80.1）
        self.page.show_dialog(
            ft.SnackBar(ft.Text(msg), show_close_icon=True, duration=3000)
        )

    def update_mirror_setting(self, e):
        mirror_type = e.data  # DropdownM2使用data属性获取选中值
        # 保存设置到配置文件
        self.config_manager.set("github.mirror", mirror_type)
        self.config_manager.save_config()

        # 判断是否应修改内部Git配置（仅限内置Git或启用了patchgit的系统Git）
        should_patch = (
            self.config_manager.get("use_sys_env", False)
            and self.config_manager.get("patchgit", False)
        ) or not self.config_manager.get("use_sys_env", False)

        if (
            should_patch
            and hasattr(self.env, "git_dir")
            and self.env.git_dir
            and os.path.exists(self.env.git_dir)
        ):
            # 使用配置文件直接操作方式
            try:
                if not self.config_manager.get("use_sys_env", False):
                    # 内置Git使用etc/gitconfig文件
                    gitconfig_path = os.path.join(
                        self.env.git_dir, "..", "etc", "gitconfig"
                    )
                    # 处理可能的路径问题（git_dir可能是bin或cmd目录）
                    if not os.path.exists(gitconfig_path):
                        gitconfig_path = os.path.join(
                            self.env.git_dir, "etc", "gitconfig"
                        )
                    if not os.path.exists(gitconfig_path):
                        gitconfig_path = os.path.join(
                            os.path.dirname(self.env.git_dir), "etc", "gitconfig"
                        )

                    # 验证最终路径是否存在
                    if not os.path.exists(os.path.dirname(gitconfig_path)):
                        self.terminal.add_log(
                            f"错误: 无法找到Git配置目录: {os.path.dirname(gitconfig_path)}"
                        )
                        return
                else:
                    # 系统Git使用internal配置文件
                    gitconfig_path = os.path.join(
                        os.path.expanduser("~"), ".gitconfig_internal"
                    )

                import configparser

                # 创建不进行插值处理的配置解析器
                gitconfig = configparser.ConfigParser(interpolation=None)

                # 为了保持配置文件格式，设置选项使键名不转换为小写
                gitconfig.optionxform = str

                # 读取现有配置
                if os.path.exists(gitconfig_path):
                    # 尝试不同的编码方式读取配置文件
                    try:
                        gitconfig.read(gitconfig_path, encoding="utf-8")
                    except UnicodeDecodeError:
                        try:
                            gitconfig.read(gitconfig_path, encoding="gbk")
                        except UnicodeDecodeError:
                            gitconfig.read(gitconfig_path, encoding="latin1")

                # 收集所有指向 https://github.com/ 的 insteadof 规则并删除
                sections_to_remove = []
                for section in gitconfig.sections():
                    if section.startswith('url "') and section.endswith('"'):
                        if gitconfig.has_option(section, "insteadof"):
                            target = gitconfig.get(section, "insteadof")
                            if target == "https://github.com/":
                                sections_to_remove.append(section)

                removed_count = 0
                for section in sections_to_remove:
                    if gitconfig.remove_section(section):
                        self.terminal.add_log(f"移除旧镜像映射: {section}")
                        removed_count += 1

                if removed_count > 0:
                    self.terminal.add_log(f"共移除 {removed_count} 个旧的镜像映射")

                # 仅当选择非GitHub镜像时才添加镜像映射
                added = False
                if mirror_type != "github":
                    # 使用镜像站作为GitHub的镜像源
                    mirror_url = f"https://{mirror_type}/https://github.com/"
                    new_section = f'url "{mirror_url}"'
                    if not gitconfig.has_section(new_section):
                        gitconfig.add_section(new_section)
                        added = True
                    elif not gitconfig.has_option(new_section, "insteadof"):
                        added = True

                    gitconfig.set(new_section, "insteadof", "https://github.com/")

                    if added:
                        self.terminal.add_log(
                            f"添加镜像映射: {new_section} -> https://github.com/"
                        )
                    else:
                        self.terminal.add_log(
                            f"更新镜像映射: {new_section} -> https://github.com/"
                        )

                # 如果没有配置项且文件不存在，则不创建空文件
                if (not gitconfig.sections()) and (not os.path.exists(gitconfig_path)):
                    self.terminal.add_log("未添加任何镜像配置，无需创建配置文件")
                    return

                # 确保目录存在
                os.makedirs(os.path.dirname(gitconfig_path), exist_ok=True)

                # 写回配置文件
                with open(gitconfig_path, "w", encoding="utf-8", newline="") as f:
                    # 手动写入文件以确保格式正确
                    for section in gitconfig.sections():
                        f.write(f"[{section}]\n")
                        for option in gitconfig.options(section):
                            value = gitconfig.get(section, option)
                            # 转义可能引起问题的字符
                            value = value.replace("%", "%%")
                            f.write(f"{option} = {value}\n")
                        f.write("\n")

                if mirror_type == "github":
                    self.terminal.add_log("已恢复使用官方GitHub源")
                else:
                    self.terminal.add_log("Git镜像配置已成功更新")

            except Exception as ex:
                self.terminal.add_log(f"更新Git配置失败: {str(ex)}")
                import traceback

                self.terminal.add_log(f"详细错误信息: {traceback.format_exc()}")

        # 若使用镜像且SillyTavern已存在，同步切换其远程地址
        if mirror_type != "github" and self.env.checkST():
            success, message = switch_git_remote_to_gitee()
            if success:
                self.terminal.add_log(
                    f"已将SillyTavern仓库远程地址切换到Gitee镜像: {message}"
                )
            else:
                self.terminal.add_log(f"切换SillyTavern仓库远程地址失败: {message}")

    def save_port(self, value):
        """保存监听端口设置"""
        try:
            port = int(value)
            if port < 1 or port > 65535:
                self.show_error_dialog("端口错误", "端口号必须在1-65535之间")
                return

            self.stCfg.port = port
            self.stCfg.save_config()
            self.page.show_dialog(ft.SnackBar(ft.Text("端口设置已保存")))
        except ValueError:
            self.show_error_dialog("端口错误", "请输入有效的端口号")

    def save_proxy_url(self, value):
        """保存代理URL设置"""
        try:
            # 保留原有requestProxy配置结构
            if "requestProxy" not in self.stCfg.config_data:
                self.stCfg.config_data["requestProxy"] = {}

            self.stCfg.proxy_url = value
            self.stCfg.config_data["requestProxy"]["url"] = value
            self.stCfg.save_config()
            self.page.show_dialog(ft.SnackBar(ft.Text("代理设置已保存")))
        except Exception as e:
            self.show_error_dialog("保存失败", f"保存代理设置失败: {str(e)}")

    def custom_args_changed(self, e):
        """处理自定义启动参数变化事件（带安全验证）"""
        custom_args = e.control.value

        # 验证参数安全性
        is_valid, error_msg = self.validate_custom_args(custom_args)
        if not is_valid:
            self.show_error_dialog("参数验证失败", error_msg)
            # 恢复为上一个有效值
            e.control.value = self.config_manager.get("custom_args", "")
            self.page.update()
            return

        self.config_manager.set("custom_args", custom_args)
        # 保存配置
        self.config_manager.save_config()

    def save_custom_args(self, value):
        """保存自定义启动参数（带安全验证）"""
        # 验证参数安全性
        is_valid, error_msg = self.validate_custom_args(value)
        if not is_valid:
            self.show_error_dialog("参数验证失败", error_msg)
            return

        self.config_manager.set("custom_args", value)
        self.config_manager.save_config()
        self.showMsg("自定义启动参数已保存")

    def optimize_args_changed(self, e):
        """处理优化参数开关变化事件"""
        use_optimize = e.control.value
        self.config_manager.set("use_optimize_args", use_optimize)
        # 保存配置
        self.config_manager.save_config()
        self.showMsg("优化参数设置已保存")

    def tray_changed(self, e):
        """处理托盘开关变化"""
        # 更新配置
        self.config_manager.set("tray", e.control.value)
        self.config_manager.save_config()

        # 实时处理托盘功能
        if e.control.value and self.tray is None:
            # 启用托盘功能且托盘未创建，则创建托盘
            try:
                from features.tray.tray import Tray

                self.tray = Tray(self.page, self)
                self.page.show_dialog(ft.SnackBar(ft.Text("托盘功能已开启")))
            except Exception as ex:
                self.show_error_dialog("托盘错误", f"托盘功能开启失败: {str(ex)}")
        elif not e.control.value and self.tray is not None:
            # 关闭托盘功能且托盘已创建，则停止托盘
            try:
                self.tray.tray.stop()
                self.tray = None
                self.page.show_dialog(ft.SnackBar(ft.Text("托盘功能已关闭")))
            except Exception as ex:
                self.show_error_dialog("托盘错误", f"托盘功能关闭失败: {str(ex)}")
        else:
            # 其他情况（已开启再次开启，或已关闭再次关闭）
            status = "开启" if e.control.value else "关闭"
            self.page.show_dialog(ft.SnackBar(ft.Text(f"托盘功能已{status}")))

    def autostart_changed(self, e):
        """处理自动启动开关变化"""
        # 更新配置
        self.config_manager.set("autostart", e.control.value)
        self.config_manager.set("tray", e.control.value)
        self.config_manager.save_config()
        # 显示操作反馈
        self.showMsg(f"自动启动功能已{'开启' if e.control.value else '关闭'}")

    async def execute_command(self, command: str, workdir: str = "SillyTavern"):
        """
        执行命令（简化版：职责完全分离）

        职责：
        1. 构建环境变量
        2. 调用 terminal 的方法创建进程
        3. 调用 terminal 的方法创建输出任务

        进程生命周期和输出处理完全由 AsyncTerminal 统一管理
        """
        import os
        import platform

        try:
            # 1. 构建环境变量
            if platform.system() == "Windows":
                # 确保工作目录存在
                if not os.path.exists(workdir):
                    os.makedirs(workdir)

                # 构建环境变量字典
                env = os.environ.copy()
                env["NODE_ENV"] = "production"
                if not self.config_manager.get("use_sys_env", False):
                    node_path = self.env.get_node_path().replace("\\", "/")
                    git_path = self.env.get_git_path().replace("\\", "/")
                    env["PATH"] = f"{node_path};{git_path};{env.get('PATH', '')}"

                # 添加ANSI颜色支持
                env["FORCE_COLOR"] = "1"

                # 禁用输出缓冲，确保实时输出
                env["PYTHONUNBUFFERED"] = "1"
            else:
                env = os.environ.copy()

            # 2. 调用 terminal 的方法创建进程
            process = await self.terminal.execute_process_async(
                command=command, workdir=workdir, env=env
            )

            if not process:
                return None

            # 3. 调用 terminal 的方法创建输出任务（terminal 完全管理输出处理）
            # 注意：如果 create_output_tasks 失败，需要清理已注册的进程以避免资源泄漏
            try:
                self.terminal.create_output_tasks(process)
            except Exception as task_error:
                # 清理已创建的进程
                import traceback

                error_details = traceback.format_exc()
                self.terminal.add_log(
                    f"[ERROR] 创建输出任务失败: {str(task_error)}\n{error_details}"
                )

                # 尝试终止并移除进程
                try:
                    if process.returncode is None:
                        process.terminate()
                        import asyncio

                        await asyncio.sleep(0.5)
                        if process.returncode is None:
                            process.kill()
                except Exception:
                    pass

                # 移除进程引用
                self.terminal.remove_process(process.pid)

                return None

            return process

        except Exception as e:
            import traceback

            error_msg = f"命令执行失败: {str(e)}\n{traceback.format_exc()}"
            self.terminal.add_log(error_msg)
            return None

    def check_and_start_sillytavern(self, e):
        """
        检查本地和远程仓库的差异，如果没有差别就启动，有差别就先更新再启动
        """
        git_path = self.env.get_git_path()
        if not self.env.checkST():
            self.terminal.add_log("SillyTavern未安装，请先安装")
            return

        self.terminal.add_log("正在检查更新...")
        if git_path:

            def on_git_fetch_complete(process):
                if process.returncode == 0:
                    self.terminal.add_log("正在检查release分支状态...")
                    # 检查本地release分支与远程release分支的差异
                    status_process = self.execute_command(
                        f'"{git_path}git" status -uno'
                    )

                    if status_process:

                        def on_status_complete(p):
                            # 使用git diff检查本地和远程release分支的差异
                            try:
                                diff_process = subprocess.run(
                                    f'"{git_path}git" diff release..origin/release',
                                    shell=True,
                                    capture_output=True,
                                    text=True,
                                    cwd="SillyTavern",
                                    creationflags=subprocess.CREATE_NO_WINDOW,
                                    encoding="utf-8",
                                    errors="ignore",  # 忽略编码错误
                                )

                                # 检查diff_process是否成功执行
                                if (
                                    diff_process.returncode == 0
                                    and diff_process.stdout is not None
                                ):
                                    # 如果没有差异，则diff_process.stdout为空
                                    if not diff_process.stdout.strip():
                                        self.terminal.add_log(
                                            "已是最新版本，正在启动SillyTavern..."
                                        )
                                        self.start_sillytavern(None)
                                    else:
                                        self.terminal.add_log(
                                            "检测到新版本，正在更新..."
                                        )
                                        # 更新完成后启动SillyTavern
                                        self.update_sillytavern_with_callback(None)
                                else:
                                    # 如果git diff命令执行失败，默认执行更新
                                    self.terminal.add_log(
                                        "检查更新状态时遇到问题，正在更新..."
                                    )
                                    self.update_sillytavern_with_callback(None)
                            except Exception as ex:
                                # 如果出现异常，默认执行更新以确保程序正常运行
                                self.terminal.add_log(
                                    f"检查更新时出错: {str(ex)}，正在更新..."
                                )
                                self.update_sillytavern_with_callback(None)

                        def wait_for_status_process():
                            # 等待异步进程完成
                            process_obj = None
                            if asyncio.iscoroutine(status_process):
                                # 正确处理协程对象
                                loop = asyncio.new_event_loop()
                                asyncio.set_event_loop(loop)
                                try:
                                    process_obj = loop.run_until_complete(
                                        status_process
                                    )
                                    loop.run_until_complete(process_obj.wait())
                                finally:
                                    loop.close()
                                    asyncio.set_event_loop(None)
                            else:
                                process_obj = status_process
                                process_obj.wait()
                            on_status_complete(process_obj)

                        threading.Thread(
                            target=wait_for_status_process, daemon=True
                        ).start()
                    else:
                        self.terminal.add_log(
                            "无法执行状态检查命令，直接启动SillyTavern..."
                        )
                        self.start_sillytavern(None)
                else:
                    self.terminal.add_log("检查更新失败，直接启动SillyTavern...")
                    self.start_sillytavern(None)

            # 获取所有分支的更新，特别是release分支
            fetch_process = self.execute_command(f'"{git_path}git" fetch --all')

            if fetch_process:

                def wait_for_fetch_process():
                    # 等待异步进程完成
                    process_obj = None
                    if asyncio.iscoroutine(fetch_process):
                        # 正确处理协程对象
                        loop = asyncio.new_event_loop()
                        asyncio.set_event_loop(loop)
                        try:
                            process_obj = loop.run_until_complete(fetch_process)
                            loop.run_until_complete(process_obj.wait())
                        finally:
                            loop.close()
                            asyncio.set_event_loop(None)
                    else:
                        process_obj = fetch_process
                        process_obj.wait()
                    on_git_fetch_complete(process_obj)

                threading.Thread(target=wait_for_fetch_process, daemon=True).start()
            else:
                self.terminal.add_log("执行更新检查命令失败，直接启动SillyTavern...")
                self.start_sillytavern(None)
        else:
            self.terminal.add_log("未找到Git路径，直接启动SillyTavern...")
            self.start_sillytavern(None)

    def start_cmd(self, e):
        """
        启动命令行窗口，设置环境变量

        安全说明：
        - 不使用 shell=True 避免命令注入
        - 直接使用 cmd.exe /k 启动交互式命令行
        - 环境变量通过 env 参数传递，而非命令行注入
        """
        import os
        import subprocess
        import platform

        try:
            if platform.system() != "Windows":
                self.terminal.add_log("启动命令行功能仅支持Windows系统")
                self.show_error_dialog("不支持", "启动命令行功能仅支持Windows系统")
                return

            # 构建新环境
            new_env = os.environ.copy()

            # 如果不使用系统环境，添加 Node.js 和 Git 路径到 PATH
            if not self.config_manager.get("use_sys_env", False):
                node_path = self.env.get_node_path()
                git_path = self.env.get_git_path()
                if node_path or git_path:
                    paths_to_add = [p for p in [node_path, git_path] if p]
                    current_path = new_env.get("PATH", "")
                    new_env["PATH"] = ";".join(paths_to_add) + (
                        ";" + current_path if current_path else ""
                    )

            # 直接启动 cmd.exe，不使用 shell 命令注入
            # /k 参数表示保持窗口打开并执行后续命令
            subprocess.Popen(
                [
                    "cmd.exe",
                    "/k",
                    "chcp 65001 >nul && echo 环境变量已设置，欢迎使用！ && cmd /k",
                ],
                env=new_env,
                creationflags=subprocess.CREATE_NEW_CONSOLE,
            )

            self.terminal.add_log("命令行窗口已启动")
            self.page.show_dialog(ft.SnackBar(ft.Text("命令行窗口已启动")))

        except Exception as ex:
            self.terminal.add_log(f"启动命令行失败: {str(ex)}")
            self.show_error_dialog("启动失败", f"启动命令行失败: {str(ex)}")

    def reset_whitelist(self, e):
        """
        重置白名单文件，使用当前设备的实际网段
        """
        from features.st.config import stcfg
        from utils.logger import app_logger

        try:
            self.terminal.add_log("正在重置白名单...")

            # 创建 stcfg 实例并调用 create_whitelist
            config = stcfg()
            if not config.create_whitelist():
                self.terminal.add_log("白名单重置失败: 无法创建白名单文件")
                self.page.show_dialog(
                    ft.SnackBar(ft.Text("白名单重置失败，请检查日志"))
                )
                return

            self.terminal.add_log("白名单已重置完成")
            self.page.show_dialog(ft.SnackBar(ft.Text("白名单已重置完成")))

        except Exception as ex:
            self.terminal.add_log(f"重置白名单失败: {str(ex)}")
            app_logger.error(f"重置白名单失败: {str(ex)}")
            self.show_error_dialog("重置失败", f"重置白名单失败: {str(ex)}")

    # ==================== SillyTavern版本切换相关方法 ====================

    def refresh_version_list(self, e):
        """
        刷新版本列表
        这个方法会在UI层面处理，这里留作占位符
        """
        # 实际刷新逻辑在st_version_ui.py中处理
        pass

    def confirm_version_switch(self, e, version_info, commit_hash):
        """
        显示版本切换确认对话框
        这个方法会在UI层面处理，这里留作占位符

        Args:
            e: 事件对象
            version_info (dict): 版本信息
            commit_hash (str): commit哈希值
        """
        # 实际确认对话框在st_version_ui.py中处理
        pass

    def switch_st_version(self, version_info, commit_hash):
        """
        执行SillyTavern版本切换（保持在release分支，避免detached HEAD）

        Args:
            version_info (dict): 版本信息 {version, commit, date, source}
            commit_hash (str): 目标commit hash
        """
        from core.git_utils import checkout_st_version, check_git_status
        import os

        try:
            # 1. 检查SillyTavern是否正在运行
            if self.terminal.is_running:
                error_msg = "错误: 请先停止SillyTavern后再切换版本"
                self.terminal.add_log(error_msg)
                app_logger.error(error_msg)
                self.show_error_dialog("切换失败", "请先停止SillyTavern后再切换版本")
                return

            self.terminal.add_log(f"开始切换到版本 v{version_info['version']}...")
            app_logger.info(f"开始切换到版本 v{version_info['version']}...")

            # 2. 检查Git工作区状态
            is_clean, status_msg = check_git_status()
            if not is_clean:
                self.terminal.add_log(f"警告: {status_msg}")
                app_logger.warning(f"版本切换警告: {status_msg}")
                self.show_error_dialog("警告", f"{status_msg}，切换可能丢失更改")

            # 3. 执行版本切换（在release分支上使用reset --hard）
            success, message = checkout_st_version(commit_hash)

            if success:
                self.terminal.add_log(f"✓ {message}")
                self.terminal.add_log(f"✓ 成功切换到版本 v{version_info['version']}")
                app_logger.info(f"成功切换到版本 v{version_info['version']}")

                # 验证当前分支状态
                from core.git_utils import get_current_commit

                verify_success, current_commit, verify_msg = get_current_commit()
                if verify_success:
                    self.terminal.add_log(f"当前commit: {current_commit[:7]}")

                # 刷新版本页面显示
                self._refresh_version_view()

                # 成功消息使用 SnackBar
                self.page.show_dialog(
                    ft.SnackBar(ft.Text(f"成功切换到版本 v{version_info['version']}"))
                )

                # 4. 询问是否安装依赖
                self._ask_install_dependencies()

            else:
                self.terminal.add_log(f"✗ {message}")
                app_logger.error(f"切换版本失败: {message}")
                self.show_error_dialog("切换失败", f"切换版本失败: {message}")

        except Exception as ex:
            error_msg = f"切换版本时发生错误: {str(ex)}"
            self.terminal.add_log(error_msg)
            app_logger.exception(error_msg)
            self.show_error_dialog("切换失败", f"切换版本时发生错误: {str(ex)}")

    def _refresh_version_view(self):
        """刷新版本页面的显示"""
        try:
            # 通过 uni_ui 访问主UI对象
            if self.uni_ui and hasattr(self.uni_ui, "version_view"):
                version_view = self.uni_ui.version_view
                if hasattr(version_view, "refresh"):
                    # 调用版本视图的刷新方法
                    version_view.refresh()
        except Exception as e:
            app_logger.exception("刷新版本视图时出错")

    def _ask_install_dependencies(self):
        """
        询问用户是否安装npm依赖
        """
        page = self.page

        dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("版本切换成功"),
            content=ft.Column(
                [
                    ft.Text("是否重新安装npm依赖？"),
                    ft.Text(
                        "建议重新安装以确保兼容性", size=13, color=ft.Colors.GREY_600
                    ),
                ],
                tight=True,
            ),
            actions=[
                ft.TextButton("暂不安装", on_click=lambda e: page.pop_dialog()),
                ft.Button(
                    "立即安装", on_click=lambda e: self._do_install_npm(page, dialog)
                ),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )

        # 使用 Flet 的标准 API 显示对话框
        page.show_dialog(dialog)

    def _do_install_npm(self, page, dialog):
        """执行npm依赖安装"""
        page.pop_dialog()
        self.terminal.add_log("正在安装npm依赖...")
        self.install_npm_dependencies()

    def install_npm_dependencies(self):
        """
        安装npm依赖
        """
        import os

        try:
            st_dir = os.path.join(os.getcwd(), "SillyTavern")

            if not os.path.exists(st_dir):
                self.terminal.add_log("错误: SillyTavern目录不存在")
                self.show_error_dialog("安装失败", "SillyTavern目录不存在")
                return

            # 检查 Node.js 路径
            node_path = self.env.get_node_path()
            if not node_path:
                self.terminal.add_log("错误: 未找到 Node.js")
                self.show_error_dialog("安装失败", "未找到 Node.js")
                return

            npm_cmd = f'"{node_path}npm" install --no-audit --no-fund --loglevel=error --no-progress --registry=https://registry.npmmirror.com'
            self.terminal.add_log("正在执行 npm install，这可能需要几分钟...")

            # 执行npm install - 注意：execute_command是异步的，需要在事件循环中运行
            async def run_install():
                return await self.execute_command(npm_cmd, workdir=st_dir)

            # 在新线程中运行异步任务
            def wait_for_install():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    process = loop.run_until_complete(run_install())
                    if process:
                        loop.run_until_complete(process.wait())
                        self.terminal.add_log("✓ npm依赖安装完成")
                        # 使用对话框显示成功消息
                        self.page.show_dialog(ft.SnackBar(ft.Text("依赖安装完成")))
                    else:
                        self.terminal.add_log("错误: 无法执行npm install")
                        self.show_error_dialog("安装失败", "无法执行npm install")
                except Exception as e:
                    self.terminal.add_log(f"安装依赖时发生错误: {str(e)}")
                    self.show_error_dialog("安装失败", f"安装依赖时发生错误: {str(e)}")
                finally:
                    loop.close()

            threading.Thread(target=wait_for_install, daemon=True).start()

        except Exception as ex:
            self.terminal.add_log(f"安装依赖时发生错误: {str(ex)}")
            self.show_error_dialog("安装失败", f"安装依赖时发生错误: {str(ex)}")
