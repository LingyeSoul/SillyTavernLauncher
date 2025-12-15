import threading
import os
import flet as ft
from env import Env
from config import ConfigManager
from stconfig import stcfg
from sysenv import SysEnv
import subprocess
import json
import asyncio
from packaging import version
import urllib.request
from git_utils import switch_git_remote_to_gitee


class UiEvent:
    def __init__(self, page, terminal, uni_ui=None):
        self.page = page
        self.terminal = terminal
        self.uni_ui = uni_ui
        self.config_manager = ConfigManager()
        self.config = self.config_manager.config
        
        use_sys_env=self.config["use_sys_env"]
        if use_sys_env:
            self.env=SysEnv()
            tmp=self.env.checkSysEnv()
            if not tmp==True:
                self.terminal.add_log(tmp)
        else:
            self.env = Env()
            tmp=self.env.checkEnv()
            if not tmp==True:
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

    def envCheck(self):
        if os.path.exists(os.path.join(os.getcwd(), "env\\")):
            return False
        else:
            return True
        
    def exit_app(self, e):
        # 销毁同步UI以清理定时器
        if self.uni_ui and hasattr(self.uni_ui, 'sync_ui'):
            try:
                self.uni_ui.sync_ui.destroy()
            except Exception as ex:
                print(f"销毁同步UI时出错: {ex}")

        # 检查是否启用了托盘功能
        if self.config_manager.get("tray", True):
            # 启用托盘时，停止所有运行的进程并隐藏窗口
            if self.terminal.is_running:
                self.terminal.stop_processes()
            self.page.window.visible = False
            self.page.update()
        else:
            # 未启用托盘时，正常退出程序
            if self.terminal.is_running:
                self.terminal.stop_processes()
            self.page.window.visible = False
            self.page.window.prevent_close = False
            self.page.update()
            self.page.window.close()


    def exit_app_with_tray(self, e):
        # 销毁同步UI以清理定时器
        if self.uni_ui and hasattr(self.uni_ui, 'sync_ui'):
            try:
                self.uni_ui.sync_ui.destroy()
            except Exception as ex:
                print(f"销毁同步UI时出错: {ex}")

        # 停止所有运行的进程
        if self.terminal.is_running:
            self.terminal.stop_processes()

        # 如果启用了托盘功能，则先停止托盘
        if self.config_manager.get("tray", True) and self.tray is not None:
            self.tray.tray.stop()
        self.exit_app(e)

    def switch_theme(self, e):
        if self.page.theme_mode == "light":
            e.control.icon = "SUNNY"
            self.page.theme_mode = "dark"
            self.config_manager.set("theme", "dark")
        else:
            e.control.icon = "MODE_NIGHT"
            self.page.theme_mode = "light"
            self.config_manager.set("theme", "light")
        
        # 保存配置
        self.config_manager.save_config()
        self.page.update()


    def install_sillytavern(self, e):
        """安装SillyTavern"""
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
                            f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                            "SillyTavern"
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
                        f'\"{git_path}git\" clone {repo_url} -b release', 
                        "."
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
                                    f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                    "SillyTavern"
                                )
                                if dep_process:
                                    await dep_process.wait()
                                    self.terminal.add_log("依赖安装完成")
                        else:
                            self.terminal.add_log("未找到nodejs")
                
                self.run_async_task(install_st())
            else:
                self.terminal.add_log("Error: Git路径未正确配置")

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
            '\u4e00', '\u9fff',  # 中文范围
            # 日文字符
            '\u3040', '\u309f',  # 平假名
            '\u30a0', '\u30ff',  # 片假名
            # 韩文字符
            '\uac00', '\ud7af',  # 韩文音节
            # 空格和空白字符
            ' ', '\t', '\n', '\r',
            # 特殊符号（Windows路径不支持或NPM容易出错的）
            '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',',
            ':', ';', '<', '=', '>', '?', '@', '[', '\\', ']', '^', '`',
            '{', '|', '}', '~',
            # 中文标点
            '，', '。', '！', '？', '；', '：', '（', '）', '【', '】',
            '、', '《', '》', '"', '"', ''', ''', '…', '——',
            # 全角字符
            '　', '！', '＂', '＃', '＄', '％', '＆', '＇', '（', '）',
            '＊', '＋', '，', '－', '．', '／', '：', '；', '＜', '＝',
            '＞', '？', '＠', '［', '＼', '］', '＾', '＿', '｀', '｛',
            '｜', '｝', '～'
        }

        # 检查路径中的每个字符
        found_problematic_chars = []
        for char in path:
            # 检查中文字符
            if '\u4e00' <= char <= '\u9fff':
                found_problematic_chars.append(f"中文字符 '{char}'")
            # 检查日文字符
            elif '\u3040' <= char <= '\u309f' or '\u30a0' <= char <= '\u30ff':
                found_problematic_chars.append(f"日文字符 '{char}'")
            # 检查韩文字符
            elif '\uac00' <= char <= '\ud7af':
                found_problematic_chars.append(f"韩文字符 '{char}'")
            # 检查其他特殊字符
            elif char in problematic_chars:
                char_type = "空格" if char == ' ' else f"特殊字符 '{char}'"
                found_problematic_chars.append(char_type)

        # 如果发现问题字符，显示详细错误信息
        if found_problematic_chars:
            error_msg = "错误：当前路径包含以下NPM不支持的字符：\n"
            # 去重并格式化错误信息
            unique_chars = list(set(found_problematic_chars))
            if len(unique_chars) <= 5:
                error_msg += "  " + "\n  ".join(unique_chars)
            else:
                error_msg += "  " + "\n  ".join(unique_chars[:5]) + f"\n  ... 还有{len(unique_chars) - 5}个其他问题字符"

            error_msg += f"\n\n当前路径：{path}"
            error_msg += "\n\n建议：请将程序移动到纯英文路径下（不包含空格和特殊字符）"
            self.terminal.add_log(error_msg)
            return False

        # 额外检查：确保路径是有效的ASCII路径
        try:
            # 尝试编码检查
            path.encode('ascii')
        except UnicodeEncodeError:
            self.terminal.add_log(f"错误：路径包含非ASCII字符，可能导致NPM运行失败\n当前路径：{path}")
            return False

        # 检查路径长度（Windows路径限制）
        if len(path) > 250:
            self.terminal.add_log(f"警告：路径长度过长（{len(path)}字符），建议缩短路径以避免潜在问题")

        # 检查是否为网络路径或特殊路径
        if path.startswith('\\\\') or ':' in path[1:]:
            self.terminal.add_log("警告：检测到网络路径或特殊驱动器路径，可能影响NPM正常运行")

        if show_success:
            self.terminal.add_log(f"路径验证通过：{path}")

        return True

    def start_sillytavern(self, e):
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
                if 'http' in proxies:
                    proxy_url = proxies['http']
                elif 'https' in proxies:
                    proxy_url = proxies['https']
                elif 'socks' in proxies:
                    proxy_url = proxies['socks']
                elif 'socks5' in proxies:
                    proxy_url = proxies['socks5']
                
                # 如果没有可用的系统代理，则关闭请求代理
                if not proxy_url:
                    self.stCfg.proxy_enabled = False
                    self.stCfg.save_config()
                    self.terminal.add_log("未检测到有效的系统代理，已自动关闭请求代理")
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
                def on_process_exit():
                    self.terminal.is_running = False
                    self.terminal.add_log("SillyTavern进程已退出")
                
                # 启动进程并设置退出回调
                custom_args = self.config_manager.get("custom_args", "")
                base_command = f"\"{self.env.get_node_path()}node\" server.js"
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
                            # Fallback for older versions of flet
                            on_process_exit()
                
                self.run_async_task(start_st())
            else:
                self.terminal.add_log("依赖未安装，请先安装依赖")
        else:
            self.terminal.add_log("SillyTavern未安装，请先安装SillyTavern")

    def stop_sillytavern(self,e):
        self.terminal.add_log("正在停止SillyTavern进程...")
        self.terminal.stop_processes()
        self.terminal.add_log("所有进程已停止")

    def restart_sillytavern(self, e):
        """重启SillyTavern服务"""
        self.terminal.add_log("正在重启SillyTavern...")
        # 先停止服务
        self.terminal.stop_processes()
        self.terminal.add_log("旧进程已停止")
        
        # 检查路径是否包含中文或空格
        current_path = os.getcwd()
        
        # 检查是否包含中文字符（使用Python内置方法）
        has_chinese = any('\u4e00' <= char <= '\u9fff' for char in current_path)
        if has_chinese:
            self.terminal.add_log("错误：路径包含中文字符，请将程序移动到不包含中文字符的路径下运行")
            return
            
        # 检查是否包含空格
        if ' ' in current_path:
            self.terminal.add_log("错误：路径包含空格，请将程序移动到不包含空格的路径下运行")
            return
            
        if self.env.checkST():
            if self.env.check_nodemodules():
                self.terminal.is_running = True
                def on_process_exit():
                    self.terminal.is_running = False
                    self.terminal.add_log("SillyTavern进程已退出")
                
                # 启动进程并设置退出回调
                custom_args = self.config_manager.get("custom_args", "")
                base_command = f"\"{self.env.get_node_path()}node\" server.js"
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
                        on_process_exit()
                    
                    threading.Thread(target=wait_for_exit, daemon=True).start()
                    self.terminal.add_log("SillyTavern已重启")
                else:
                    self.terminal.add_log("重启失败")
            else:
                self.terminal.add_log("依赖项未安装")
        else:
            self.terminal.add_log("SillyTavern未安装")

    
    def update_sillytavern(self, e):
        # 验证路径是否适合NPM运行
        if not self.validate_path_for_npm():
            return

        git_path = self.env.get_git_path()
        if self.env.checkST():
            self.terminal.add_log("正在更新SillyTavern...")
            if git_path:
                # 检查当前远程仓库地址是否正确
                mirror_type = self.config_manager.get("github.mirror", "github")
                
                # 确保远程仓库地址正确
                if mirror_type == "github":
                    expected_remote = "https://github.com/SillyTavern/SillyTavern.git"
                else:
                    expected_remote = "https://gitee.com/lingyesoul/SillyTavern.git"
                
                try:
                    # 获取当前远程仓库地址
                    current_remote_process = subprocess.run(
                        f'\"{git_path}git\" remote get-url origin',
                        shell=True,
                        capture_output=True,
                        text=True,
                        cwd=self.env.st_dir,
                        creationflags=subprocess.CREATE_NO_WINDOW
                    )
                    
                    if current_remote_process.returncode == 0:
                        current_remote = current_remote_process.stdout.strip()
                        if current_remote != expected_remote:
                            # 更新远程仓库地址
                            self.terminal.add_log(f"更新远程仓库地址: {expected_remote}")
                            subprocess.run(
                                f'\"{git_path}git\" remote set-url origin {expected_remote}',
                                shell=True,
                                cwd=self.env.st_dir,
                                creationflags=subprocess.CREATE_NO_WINDOW
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
                                    f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                    "SillyTavern"
                                )
                                if process:
                                    await process.wait()
                                    on_npm_complete(process)
                            
                            self.run_async_task(install_deps())
                        else:
                            self.terminal.add_log("未找到nodejs")
                    else:
                        # 检查是否是由于package-lock.json冲突导致的更新失败
                        self.terminal.add_log("Git更新失败，检查是否为package-lock.json冲突...")
                        try:
                            # 尝试解决package-lock.json冲突
                            reset_process = subprocess.run(
                                f'\"{git_path}git\" checkout -- package-lock.json',
                                shell=True,
                                cwd=self.env.st_dir,
                                creationflags=subprocess.CREATE_NO_WINDOW,
                                capture_output=True,
                                text=True
                            )
                            
                            if reset_process.returncode == 0:
                                self.terminal.add_log("已重置package-lock.json，重新尝试更新...")
                                # 重新执行git pull
                                async def retry_update():
                                    retry_process = await self.execute_command(
                                        f'\"{git_path}git\" pull --rebase --autostash', 
                                        "SillyTavern"
                                    )
                                    if retry_process:
                                        await retry_process.wait()
                                        # 避免递归调用，直接处理结果
                                        if retry_process.returncode == 0:
                                            self.terminal.add_log("Git更新成功")
                                            if self.env.get_node_path():
                                                self.terminal.add_log("正在安装依赖...")
                                                def on_npm_complete(process):
                                                    if process.returncode == 0:
                                                        self.terminal.add_log("依赖安装成功")
                                                    else:
                                                        self.terminal.add_log("依赖安装失败")
                                                
                                                async def install_deps():
                                                    process = await self.execute_command(
                                                        f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                                        "SillyTavern"
                                                    )
                                                    if process:
                                                        await process.wait()
                                                        on_npm_complete(process)
                                                
                                                self.run_async_task(install_deps())
                                            else:
                                                self.terminal.add_log("未找到nodejs")
                                        else:
                                            self.terminal.add_log("重试更新失败")
                                
                                self.run_async_task(retry_update())
                            else:
                                self.terminal.add_log("无法解决package-lock.json冲突，需要手动处理")
                        except Exception as ex:
                            self.terminal.add_log(f"处理package-lock.json冲突时出错: {str(ex)}")
                
                # 使用异步方式执行git pull
                async def git_pull():
                    process = await self.execute_command(
                        f'\"{git_path}git\" pull --rebase --autostash', 
                        "SillyTavern"
                    )
                    if process:
                        await process.wait()
                        on_git_complete(process)
                
                self.run_async_task(git_pull())
            else:
                self.terminal.add_log("未找到Git路径，请手动更新SillyTavern")

    def update_sillytavern_with_callback(self, e):
        """
        更新SillyTavern并在完成后自动启动
        """
        # 验证路径是否适合NPM运行
        if not self.validate_path_for_npm():
            return

        git_path = self.env.get_git_path()
        if self.env.checkST():
            self.terminal.add_log("正在更新SillyTavern...")
            if git_path:
                # 执行git pull
                def on_git_complete(process, retry_count=0):
                    if process.returncode == 0:
                        self.terminal.add_log("Git更新成功")
                        if self.env.get_node_path():
                            self.terminal.add_log("正在安装依赖...")
                            def on_npm_complete(process, npm_retry_count=0):
                                if process.returncode == 0:
                                    self.terminal.add_log("依赖安装成功，正在启动SillyTavern...")
                                    self.start_sillytavern(None)
                                else:
                                    if npm_retry_count < 2:
                                        self.terminal.add_log(f"依赖安装失败，正在重试... (尝试次数: {npm_retry_count + 1}/2)")
                                        # 清理npm缓存
                                        async def clean_cache():
                                            cache_process = await self.execute_command(
                                                f"\"{self.env.get_node_path()}npm\" cache clean --force",
                                                "SillyTavern"
                                            )
                                            if cache_process:
                                                await cache_process.wait()
                                                # 删除node_modules
                                                node_modules_path = os.path.join(self.env.st_dir, "node_modules")
                                                if os.path.exists(node_modules_path):
                                                    try:
                                                        import shutil
                                                        shutil.rmtree(node_modules_path)
                                                    except Exception as ex:
                                                        self.terminal.add_log(f"删除node_modules失败: {str(ex)}")
                                                # 重新安装依赖
                                                async def retry_install():
                                                    retry_process = await self.execute_command(
                                                        f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com",
                                                        "SillyTavern"
                                                    )
                                                    if retry_process:
                                                        await retry_process.wait()
                                                        # 在主线程中调用回调
                                                        try:
                                                            self.page.run_task(lambda: on_npm_complete(retry_process, npm_retry_count + 1))
                                                        except AttributeError:
                                                            on_npm_complete(retry_process, npm_retry_count + 1)
                                                
                                                self.run_async_task(retry_install())
                                        
                                        self.run_async_task(clean_cache())
                                    else:
                                        self.terminal.add_log("依赖安装失败，正在启动SillyTavern...")
                                        self.start_sillytavern(None)
                            
                            async def install_deps():
                                process = await self.execute_command(
                                    f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                    "SillyTavern"
                                )
                                if process:
                                    await process.wait()
                                    # 在主线程中调用回调
                                    try:
                                        self.page.run_task(lambda: on_npm_complete(process, 0))
                                    except AttributeError:
                                        on_npm_complete(process, 0)
                            
                            self.run_async_task(install_deps())
                        else:
                            self.terminal.add_log("未找到nodejs，正在启动SillyTavern...")
                            self.start_sillytavern(None)
                    else:
                        # 检查重试次数，避免无限重试
                        if retry_count < 2:
                            self.terminal.add_log(f"Git更新失败，检查是否为package-lock.json冲突... (尝试次数: {retry_count + 1}/2)")
                            try:
                                # 尝试解决package-lock.json冲突
                                reset_process = subprocess.run(
                                    f'\"{git_path}git\" checkout -- package-lock.json',
                                    shell=True,
                                    cwd=self.env.st_dir,
                                    creationflags=subprocess.CREATE_NO_WINDOW,
                                    capture_output=True,
                                    text=True
                                )
                                
                                if reset_process.returncode == 0:
                                    self.terminal.add_log("已重置package-lock.json，重新尝试更新...")
                                    # 重新执行git pull
                                    async def retry_update():
                                        retry_process = await self.execute_command(
                                            f'\"{git_path}git\" pull --rebase --autostash', 
                                            "SillyTavern"
                                        )
                                        if retry_process:
                                            await retry_process.wait()
                                            # 避免递归调用，直接处理结果
                                            # 在主线程中调用回调
                                            try:
                                                self.page.run_task(lambda: on_git_complete(retry_process, retry_count + 1))
                                            except AttributeError:
                                                on_git_complete(retry_process, retry_count + 1)
                                    
                                    self.run_async_task(retry_update())
                                else:
                                    self.terminal.add_log("无法解决package-lock.json冲突，需要手动处理")
                            except Exception as ex:
                                self.terminal.add_log(f"处理package-lock.json冲突时出错: {str(ex)}")
                        else:
                            self.terminal.add_log("Git更新失败，正在启动SillyTavern...")
                            self.start_sillytavern(None)
                
                async def git_pull():
                    process = await self.execute_command(
                        f'\"{git_path}git\" pull --rebase --autostash', 
                        "SillyTavern"
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

    def port_changed(self,e):
        self.stCfg.port = e.control.value
        self.stCfg.save_config()
        self.showMsg('配置文件已保存')
        
    def listen_changed(self,e):
        self.stCfg.listen = e.control.value
        if self.stCfg.listen:
            self.stCfg.create_whitelist()
        self.stCfg.save_config()
        self.showMsg('配置文件已保存')

    def auto_proxy_changed(self, e):
        """处理自动代理设置开关变化事件"""
        auto_proxy = e.control.value
        self.config_manager.set("auto_proxy", auto_proxy)
        self.config_manager.save_config()
        
        if auto_proxy:
            # 启用自动代理时，自动检测并设置代理
            self.auto_detect_and_set_proxy()
        
        self.showMsg('自动代理设置已更新')

    def auto_detect_and_set_proxy(self):
        """自动检测系统代理并设置"""
        try:
            # 获取系统代理设置
            proxies = urllib.request.getproxies()
            self.terminal.add_log(f"检测到的系统代理: {proxies}")
            
            # 查找HTTP或SOCKS代理
            proxy_url = ""
            if 'http' in proxies:
                proxy_url = proxies['http']
            elif 'https' in proxies:
                proxy_url = proxies['https']
            elif 'socks' in proxies:
                proxy_url = proxies['socks']
            elif 'socks5' in proxies:
                proxy_url = proxies['socks5']
            
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
                    if hasattr(self, 'page') and self.page:
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

    def proxy_url_changed(self,e):
        self.stCfg.proxy_url = e.control.value
        self.stCfg.save_config()
        self.showMsg('配置文件已保存')
        
    def proxy_changed(self,e):
        self.stCfg.proxy_enabled = e.control.value
        self.stCfg.save_config()
        self.showMsg('配置文件已保存')
        
    def env_changed(self,e):
        use_sys_env = e.control.value
        self.config_manager.set("use_sys_env", use_sys_env)
        if use_sys_env:
            self.env = SysEnv()
        else:
            self.env = Env()
        
        # 保存配置
        self.config_manager.save_config()
        self.showMsg('环境设置已保存')
    
    def patchgit_changed(self,e):
        patchgit = e.control.value
        self.config_manager.set("patchgit", patchgit)
        # 保存配置
        self.config_manager.save_config()
        self.showMsg('设置已保存')
        
    def sys_env_check(self,e):
        sysenv = SysEnv()
        tmp = sysenv.checkSysEnv()
        if tmp == True:
            self.showMsg(f'{tmp} Git：{sysenv.get_git_path()} NodeJS：{sysenv.get_node_path()}')
        else:
            self.showMsg(f'{tmp}')
            
    def in_env_check(self,e):
        inenv = Env()
        tmp = inenv.checkEnv()
        if tmp == True:
            self.showMsg(f'{tmp} Git：{inenv.get_git_path()} NodeJS：{inenv.get_node_path()}')
        else:
            self.showMsg(f'{tmp}')
            
    def checkupdate_changed(self, e):
        """
        处理自动检查更新设置变更
        """
        checkupdate = e.control.value
        self.config_manager.set("checkupdate", checkupdate)
        # 保存配置
        self.config_manager.save_config()
        self.showMsg('设置已保存')

    def stcheckupdate_changed(self, e):
        """
        处理酒馆自动检查更新设置变更
        """
        checkupdate = e.control.value
        self.config_manager.set("stcheckupdate", checkupdate)
        # 保存配置
        self.config_manager.save_config()
        self.showMsg('设置已保存')

    def showMsg(self, msg):
        self.page.open(ft.SnackBar(ft.Text(msg), show_close_icon=True, duration=3000))

    def update_mirror_setting(self, e):
        mirror_type = e.data  # DropdownM2使用data属性获取选中值
        # 保存设置到配置文件
        self.config_manager.set("github.mirror", mirror_type)
        self.config_manager.save_config()
            
        # 判断是否应修改内部Git配置（仅限内置Git或启用了patchgit的系统Git）
        should_patch = (
            (self.config_manager.get("use_sys_env", False) and self.config_manager.get("patchgit", False)) 
            or not self.config_manager.get("use_sys_env", False)
        )
        
        if should_patch and hasattr(self.env, 'git_dir') and self.env.git_dir and os.path.exists(self.env.git_dir):
            # 使用配置文件直接操作方式
            try:
                if not self.config_manager.get("use_sys_env", False):
                    # 内置Git使用etc/gitconfig文件
                    gitconfig_path = os.path.join(self.env.git_dir, "..", "etc", "gitconfig")
                    # 处理可能的路径问题（git_dir可能是bin或cmd目录）
                    if not os.path.exists(gitconfig_path):
                        gitconfig_path = os.path.join(self.env.git_dir, "etc", "gitconfig")
                    if not os.path.exists(gitconfig_path):
                        gitconfig_path = os.path.join(os.path.dirname(self.env.git_dir), "etc", "gitconfig")
                    
                    # 验证最终路径是否存在
                    if not os.path.exists(os.path.dirname(gitconfig_path)):
                        self.terminal.add_log(f"错误: 无法找到Git配置目录: {os.path.dirname(gitconfig_path)}")
                        return
                else:
                    # 系统Git使用internal配置文件
                    gitconfig_path = os.path.join(os.path.expanduser("~"), ".gitconfig_internal")
                
                import configparser
                # 创建不进行插值处理的配置解析器
                gitconfig = configparser.ConfigParser(interpolation=None)
                
                # 为了保持配置文件格式，设置选项使键名不转换为小写
                gitconfig.optionxform = str
                
                # 读取现有配置
                if os.path.exists(gitconfig_path):
                    # 尝试不同的编码方式读取配置文件
                    try:
                        gitconfig.read(gitconfig_path, encoding='utf-8')
                    except UnicodeDecodeError:
                        try:
                            gitconfig.read(gitconfig_path, encoding='gbk')
                        except UnicodeDecodeError:
                            gitconfig.read(gitconfig_path, encoding='latin1')
                
                # 收集所有指向 https://github.com/ 的 insteadof 规则并删除
                sections_to_remove = []
                for section in gitconfig.sections():
                    if section.startswith('url "') and section.endswith('"'):
                        if gitconfig.has_option(section, 'insteadof'):
                            target = gitconfig.get(section, 'insteadof')
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
                        self.terminal.add_log(f"添加镜像映射: {new_section} -> https://github.com/")
                    else:
                        self.terminal.add_log(f"更新镜像映射: {new_section} -> https://github.com/")

                # 如果没有配置项且文件不存在，则不创建空文件
                if (not gitconfig.sections()) and (not os.path.exists(gitconfig_path)):
                    self.terminal.add_log("未添加任何镜像配置，无需创建配置文件")
                    return

                # 确保目录存在
                os.makedirs(os.path.dirname(gitconfig_path), exist_ok=True)
                
                # 写回配置文件
                with open(gitconfig_path, 'w', encoding='utf-8', newline='') as f:
                    # 手动写入文件以确保格式正确
                    for section in gitconfig.sections():
                        f.write(f"[{section}]\n")
                        for option in gitconfig.options(section):
                            value = gitconfig.get(section, option)
                            # 转义可能引起问题的字符
                            value = value.replace('%', '%%')
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
                self.terminal.add_log(f"已将SillyTavern仓库远程地址切换到Gitee镜像: {message}")
            else:
                self.terminal.add_log(f"切换SillyTavern仓库远程地址失败: {message}")

    def save_port(self, value):
        """保存监听端口设置"""
        try:
            port = int(value)
            if port < 1 or port > 65535:
                self.showMsg("端口号必须在1-65535之间")
                return
            
            self.stCfg.port = port
            self.stCfg.save_config()
            self.showMsg("端口设置已保存")
        except ValueError:
            self.showMsg("请输入有效的端口号")

    def save_proxy_url(self, value):
        """保存代理URL设置"""
        try:
            # 保留原有requestProxy配置结构
            if 'requestProxy' not in self.stCfg.config_data:
                self.stCfg.config_data['requestProxy'] = {}
            
            self.stCfg.proxy_url = value
            self.stCfg.config_data['requestProxy']['url'] = value
            self.stCfg.save_config()
            self.showMsg("代理设置已保存")
        except Exception as e:
            self.showMsg(f"保存代理设置失败: {str(e)}")

    def log_changed(self, e):
        """处理日志开关变化事件"""
        log_enabled = e.control.value
        self.config_manager.set("log", log_enabled)
        # 更新终端的日志设置
        self.terminal.update_log_setting(log_enabled)
        # 保存配置
        self.config_manager.save_config()
        self.showMsg('日志设置已保存')

    def custom_args_changed(self, e):
        """处理自定义启动参数变化事件"""
        custom_args = e.control.value
        self.config_manager.set("custom_args", custom_args)
        # 保存配置
        self.config_manager.save_config()

    def save_custom_args(self, value):
        """保存自定义启动参数"""
        self.config_manager.set("custom_args", value)
        self.config_manager.save_config()
        self.showMsg('自定义启动参数已保存')

    def tray_changed(self, e):
        """处理托盘开关变化"""
        # 更新配置
        self.config_manager.set("tray", e.control.value)
        self.config_manager.save_config()
        
        # 实时处理托盘功能
        if e.control.value and self.tray is None:
            # 启用托盘功能且托盘未创建，则创建托盘
            try:
                from tray import Tray
                self.tray = Tray(self.page, self)
                self.showMsg("托盘功能已开启")
            except Exception as ex:
                self.showMsg(f"托盘功能开启失败: {str(ex)}")
        elif not e.control.value and self.tray is not None:
            # 关闭托盘功能且托盘已创建，则停止托盘
            try:
                self.tray.tray.stop()
                self.tray = None
                self.showMsg("托盘功能已关闭")
            except Exception as ex:
                self.showMsg(f"托盘功能关闭失败: {str(ex)}")
        else:
            # 其他情况（已开启再次开启，或已关闭再次关闭）
            self.showMsg(f"托盘功能已{'开启' if e.control.value else '关闭'}")

    def autostart_changed(self, e):
        """处理自动启动开关变化"""
        # 更新配置
        self.config_manager.set("autostart", e.control.value)
        self.config_manager.set("tray", e.control.value)
        self.config_manager.save_config()
        # 显示操作反馈
        self.showMsg(f"自动启动功能已{'开启' if e.control.value else '关闭'}")
    
    async def execute_command(self, command: str, workdir: str = "SillyTavern"):
        import os
        import platform
        import asyncio
        import subprocess
        try:
            # 根据操作系统设置环境变量
            if platform.system() == "Windows":
                # 确保工作目录存在
                if not os.path.exists(workdir):
                    os.makedirs(workdir)
                
                # 构建环境变量字典
                env = os.environ.copy()
                env['NODE_ENV'] = 'production'
                if not self.config_manager.get("use_sys_env", False):
                    node_path = self.env.get_node_path().replace('\\', '/')
                    git_path = self.env.get_git_path().replace('\\', '/')
                    env['PATH'] = f"{node_path};{git_path};{env.get('PATH', '')}"
                
                # 添加ANSI颜色支持
                env['FORCE_COLOR'] = '1'

                self.terminal.add_log(f"{workdir} $ {command}")
                # 启动进程并记录(优化Windows参数)
                process = await asyncio.create_subprocess_shell(
                    command,  # 直接执行原始命令
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=workdir,
                    env=env,  # 使用自定义环境变量
                    creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
                )
                
                self.terminal.active_processes.append({
                    'process': process,
                    'pid': process.pid,
                    'command': command
                })
            
            # 读取输出的异步方法
            async def read_output_async(stream, is_stderr=False):
                # 使用更大的缓冲区大小以提高性能
                buffer_size = 16384  # 增加到16KB
                buffer = b""
                delimiter = b'\n'
                
                while True:
                    try:
                        # 使用固定大小读取数据以避免LimitOverrunError
                        chunk = await stream.read(buffer_size)
                        if not chunk:  # 如果没有数据且流已结束，则退出循环
                            # 处理缓冲区中剩余的数据（即使没有换行符）
                            if buffer:
                                clean_line = buffer.decode('utf-8', errors='replace').rstrip('\r\n')
                                if clean_line:  # 只有当文本非空时才添加日志
                                    self.terminal.add_log(clean_line)
                            break
                        
                        # 将新读取的数据添加到缓冲区
                        buffer += chunk
                        
                        # 处理缓冲区中的完整行
                        while delimiter in buffer:
                            line, buffer = buffer.split(delimiter, 1)
                            clean_line = line.decode('utf-8', errors='replace').rstrip('\r\n')
                            if clean_line:  # 只有当文本非空时才添加日志
                                self.terminal.add_log(clean_line)
                    
                    except Exception as ex:
                        import traceback
                        if hasattr(self.terminal, 'view') and self.terminal.view.page:
                            self.terminal.add_log(f"输出处理错误: {type(ex).__name__}: {str(ex)}")
                            self.terminal.add_log(f"错误详情: {traceback.format_exc()}")
                        break

            # 创建并启动异步输出处理任务
            stdout_task = asyncio.create_task(read_output_async(process.stdout, False))
            stderr_task = asyncio.create_task(read_output_async(process.stderr, True))
            
            # 将任务添加到终端的任务列表中以便后续管理
            if not hasattr(self.terminal, '_output_tasks'):
                self.terminal._output_tasks = []
            self.terminal._output_tasks.extend([stdout_task, stderr_task])
            
            return process
        except Exception as e:
            import traceback
            self.terminal.add_log(f"Error: {str(e)}")
            self.terminal.add_log(f"错误详情: {traceback.format_exc()}")
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
                    status_process = self.execute_command(f'\"{git_path}git\" status -uno')

                    if status_process:
                        def on_status_complete(p):
                            # 使用git diff检查本地和远程release分支的差异
                            try:
                                diff_process = subprocess.run(
                                    f'\"{git_path}git\" diff release..origin/release',
                                    shell=True,
                                    capture_output=True,
                                    text=True,
                                    cwd="SillyTavern",
                                    creationflags=subprocess.CREATE_NO_WINDOW,
                                    encoding='utf-8',
                                    errors='ignore'  # 忽略编码错误
                                )
                                
                                # 检查diff_process是否成功执行
                                if diff_process.returncode == 0 and diff_process.stdout is not None:
                                    # 如果没有差异，则diff_process.stdout为空
                                    if not diff_process.stdout.strip():
                                        self.terminal.add_log("已是最新版本，正在启动SillyTavern...")
                                        self.start_sillytavern(None)
                                    else:
                                        self.terminal.add_log("检测到新版本，正在更新...")
                                        # 更新完成后启动SillyTavern
                                        self.update_sillytavern_with_callback(None)
                                else:
                                    # 如果git diff命令执行失败，默认执行更新
                                    self.terminal.add_log("检查更新状态时遇到问题，正在更新...")
                                    self.update_sillytavern_with_callback(None)
                            except Exception as ex:
                                # 如果出现异常，默认执行更新以确保程序正常运行
                                self.terminal.add_log(f"检查更新时出错: {str(ex)}，正在更新...")
                                self.update_sillytavern_with_callback(None)

                        def wait_for_status_process():
                            # 等待异步进程完成
                            process_obj = None
                            if asyncio.iscoroutine(status_process):
                                # 正确处理协程对象
                                loop = asyncio.new_event_loop()
                                asyncio.set_event_loop(loop)
                                try:
                                    process_obj = loop.run_until_complete(status_process)
                                    loop.run_until_complete(process_obj.wait())
                                finally:
                                    loop.close()
                                    asyncio.set_event_loop(None)
                            else:
                                process_obj = status_process
                                process_obj.wait()
                            on_status_complete(process_obj)
                        
                        threading.Thread(
                            target=wait_for_status_process,
                            daemon=True
                        ).start()
                    else:
                        self.terminal.add_log("无法执行状态检查命令，直接启动SillyTavern...")
                        self.start_sillytavern(None)
                else:
                    self.terminal.add_log("检查更新失败，直接启动SillyTavern...")
                    self.start_sillytavern(None)

            # 获取所有分支的更新，特别是release分支
            fetch_process = self.execute_command(f'\"{git_path}git\" fetch --all')

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
                
                threading.Thread(
                    target=wait_for_fetch_process,
                    daemon=True
                ).start()
            else:
                self.terminal.add_log("执行更新检查命令失败，直接启动SillyTavern...")
                self.start_sillytavern(None)
        else:
            self.terminal.add_log("未找到Git路径，直接启动SillyTavern...")
            self.start_sillytavern(None)