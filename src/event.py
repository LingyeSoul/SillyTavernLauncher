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


class UiEvent:
    def __init__(self, page, terminal):
        self.page = page
        self.terminal = terminal
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

    def envCheck(self):
        if os.path.exists(os.path.join(os.getcwd(), "env\\")):
            return False
        else:
            return True
        
    def exit_app(self, e):
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


    def install_sillytavern(self,e):
        git_path = self.env.get_git_path()
        if self.env.checkST():
            self.terminal.add_log("SillyTavern已安装")
            if self.env.get_node_path():
                if self.env.check_nodemodules():
                    self.terminal.add_log("依赖项已安装")
                else:
                    self.terminal.add_log("正在安装依赖...")
                    def on_npm_complete(process):
                        if process.returncode == 0:
                            self.terminal.add_log("依赖安装成功")
                            self.stCfg=stcfg()
                        else:
                            self.terminal.add_log("依赖安装失败，正在重试...")
                            # 清理npm缓存
                            cache_process = self.execute_command(
                                f"\"{self.env.get_node_path()}npm\" cache clean --force",
                                "SillyTavern"
                            )
                            if cache_process:
                                # 等待异步进程完成
                                process_obj = None
                                if asyncio.iscoroutine(cache_process):
                                    # 正确处理协程对象
                                    loop = asyncio.new_event_loop()
                                    asyncio.set_event_loop(loop)
                                    try:
                                        process_obj = loop.run_until_complete(cache_process)
                                        loop.run_until_complete(process_obj.wait())
                                    finally:
                                        loop.close()
                                        asyncio.set_event_loop(None)
                                else:
                                    process_obj = cache_process
                                    process_obj.wait()
                            # 删除node_modules
                            node_modules_path = os.path.join(self.env.st_dir, "node_modules")
                            if os.path.exists(node_modules_path):
                                try:
                                    import shutil
                                    shutil.rmtree(node_modules_path)
                                except Exception as ex:
                                    self.terminal.add_log(f"删除node_modules失败: {str(ex)}")
                            # 重新安装依赖
                            retry_process = self.execute_command(
                                f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com",
                                "SillyTavern"
                            )
                            if retry_process:
                                def on_retry_complete(p):
                                    if p.returncode == 0:
                                        self.terminal.add_log("依赖安装成功")
                                    else:
                                        self.terminal.add_log("依赖安装失败")
                                
                                def wait_for_retry_process():
                                    # 等待异步进程完成
                                    process_obj = None
                                    if asyncio.iscoroutine(retry_process):
                                        # 正确处理协程对象
                                        loop = asyncio.new_event_loop()
                                        asyncio.set_event_loop(loop)
                                        try:
                                            process_obj = loop.run_until_complete(retry_process)
                                            loop.run_until_complete(process_obj.wait())
                                        finally:
                                            loop.close()
                                            asyncio.set_event_loop(None)
                                    else:
                                        process_obj = retry_process
                                        process_obj.wait()
                                    on_retry_complete(process_obj)
                                    
                                    threading.Thread(
                                    target=wait_for_retry_process,
                                    daemon=True
                                ).start()
                    
                    process = self.execute_command(
                        f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                        "SillyTavern"
                    )
                    
                    if process:
                        def wait_for_process():
                            # 等待异步进程完成
                            process_obj = None
                            if asyncio.iscoroutine(process):
                                # 正确处理协程对象
                                loop = asyncio.new_event_loop()
                                asyncio.set_event_loop(loop)
                                try:
                                    process_obj = loop.run_until_complete(process)
                                    loop.run_until_complete(process_obj.wait())
                                finally:
                                    loop.close()
                                    asyncio.set_event_loop(None)
                            else:
                                process_obj = process
                                process_obj.wait()
                            on_npm_complete(process_obj)
                        
                        threading.Thread(
                            target=wait_for_process,
                            daemon=True
                        ).start()
            else:
                self.terminal.add_log("未找到nodejs")
        else:
            if git_path:
                repo_url = "https://github.com/SillyTavern/SillyTavern"
                self.terminal.add_log("正在安装SillyTavern...")
                def on_git_complete(process):
                    if process.returncode == 0:
                        self.terminal.add_log("安装成功")
                        self.stCfg=stcfg()
                        if self.env.get_node_path():
                            self.terminal.add_log("正在安装依赖...")
                            def on_npm_complete(process):
                                if process.returncode == 0:
                                    self.terminal.add_log("依赖安装成功")
                                else:
                                    self.terminal.add_log("依赖安装失败，正在重试...")
                                    # 清理npm缓存
                                    cache_process = self.execute_command(
                                        f"\"{self.env.get_node_path()}npm\" cache clean --force",
                                        "SillyTavern"
                                    )
                                    if cache_process:
                                        # 等待异步进程完成
                                        if asyncio.iscoroutine(cache_process):
                                            # 正确处理协程对象
                                            loop = asyncio.new_event_loop()
                                            asyncio.set_event_loop(loop)
                                            try:
                                                process_obj = loop.run_until_complete(cache_process)
                                                loop.run_until_complete(process_obj.wait())
                                            finally:
                                                loop.close()
                                                asyncio.set_event_loop(None)
                                        else:
                                            cache_process.wait()
                                    # 删除node_modules
                                    node_modules_path = os.path.join(self.env.st_dir, "node_modules")
                                    if os.path.exists(node_modules_path):
                                        try:
                                            import shutil
                                            shutil.rmtree(node_modules_path)
                                        except Exception as ex:
                                            self.terminal.add_log(f"删除node_modules失败: {str(ex)}")
                                    # 重新安装依赖
                                    retry_process = self.execute_command(
                                        f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com",
                                        "SillyTavern"
                                    )
                                    if retry_process:
                                        def on_retry_complete(p):
                                            if p.returncode == 0:
                                                self.terminal.add_log("依赖安装成功")
                                            else:
                                                self.terminal.add_log("依赖安装失败")
                                        
                                        def wait_for_retry_process():
                                            # 等待异步进程完成
                                            process_obj = None
                                            if asyncio.iscoroutine(retry_process):
                                                # 正确处理协程对象
                                                loop = asyncio.new_event_loop()
                                                asyncio.set_event_loop(loop)
                                                try:
                                                    process_obj = loop.run_until_complete(retry_process)
                                                    loop.run_until_complete(process_obj.wait())
                                                finally:
                                                    loop.close()
                                                    asyncio.set_event_loop(None)
                                            else:
                                                process_obj = retry_process
                                                process_obj.wait()
                                            on_retry_complete(process_obj)
                                        
                                        threading.Thread(
                                            target=wait_for_retry_process,
                                            daemon=True
                                        ).start()
                            
                            process = self.execute_command(
                                f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                "SillyTavern"
                            )
                            
                            if process:
                                def wait_for_process():
                                    # 等待异步进程完成
                                    process_obj = None
                                    if asyncio.iscoroutine(process):
                                        # 正确处理协程对象
                                        loop = asyncio.new_event_loop()
                                        asyncio.set_event_loop(loop)
                                        try:
                                            process_obj = loop.run_until_complete(process)
                                            loop.run_until_complete(process_obj.wait())
                                        finally:
                                            loop.close()
                                            asyncio.set_event_loop(None)
                                    else:
                                        process_obj = process
                                        process_obj.wait()
                                    on_npm_complete(process_obj)
                                
                                threading.Thread(
                                    target=wait_for_process,
                                    daemon=True
                                ).start()
                        else:
                            self.terminal.add_log("未找到nodejs")
                    else:
                        self.terminal.add_log("安装失败")
                
                process = self.execute_command(
                    f'\"{git_path}git\" clone {repo_url} -b release', 
                    "."
                )
                
                if process:
                    def wait_for_process():
                        # 等待异步进程完成
                        process_obj = None
                        if asyncio.iscoroutine(process):
                            # 对于协程对象，先运行它获取进程对象，然后等待进程完成
                            loop = asyncio.new_event_loop()
                            asyncio.set_event_loop(loop)
                            try:
                                process_obj = loop.run_until_complete(process)
                                loop.run_until_complete(process_obj.wait())
                            finally:
                                loop.close()
                        else:
                            process.wait()
                        on_git_complete(process)
                    
                    threading.Thread(
                        target=wait_for_process,
                        daemon=True
                    ).start()
            else:
                self.terminal.add_log("Error: Git路径未正确配置")

    def start_sillytavern(self,e):
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
                process = self.execute_command(f"\"{self.env.get_node_path()}node\" server.js %*", "SillyTavern")
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
                    self.terminal.add_log("SillyTavern已启动")
                else:
                    self.terminal.add_log("启动失败")
            else:
                self.terminal.add_log("依赖项未安装")
        else:
            self.terminal.add_log("SillyTavern未安装")
        

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
                process = self.execute_command(f"\"{self.env.get_node_path()}node\" server.js %*", "SillyTavern")
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

    
    def update_sillytavern(self,e):
        git_path = self.env.get_git_path()
        if self.env.checkST():
            self.terminal.add_log("正在更新SillyTavern...")
            if git_path:
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
                            
                            process = self.execute_command(f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", "SillyTavern")
                            if process:
                                def wait_for_process():
                                    # 等待异步进程完成
                                    process_obj = None
                                    if asyncio.iscoroutine(process):
                                        # 正确处理协程对象
                                        loop = asyncio.new_event_loop()
                                        asyncio.set_event_loop(loop)
                                        try:
                                            process_obj = loop.run_until_complete(process)
                                            loop.run_until_complete(process_obj.wait())
                                        finally:
                                            loop.close()
                                            asyncio.set_event_loop(None)
                                    else:
                                        process_obj = process
                                        process_obj.wait()
                                    on_npm_complete(process_obj)
                                
                                threading.Thread(target=wait_for_process,daemon=True).start()
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
                                retry_process = self.execute_command(
                                    f'\"{git_path}git\" pull --rebase --autostash', 
                                    "SillyTavern"
                                )
                                
                                if retry_process:
                                    def wait_for_retry_process():
                                        # 等待异步进程完成
                                        process_obj = None
                                        if asyncio.iscoroutine(retry_process):
                                            # 正确处理协程对象
                                            loop = asyncio.new_event_loop()
                                            asyncio.set_event_loop(loop)
                                            try:
                                                process_obj = loop.run_until_complete(retry_process)
                                                loop.run_until_complete(process_obj.wait())
                                            finally:
                                                loop.close()
                                                asyncio.set_event_loop(None)
                                        else:
                                            process_obj = retry_process
                                            process_obj.wait()
                                        # 避免递归调用，直接处理结果
                                        if process_obj.returncode == 0:
                                            self.terminal.add_log("Git更新成功")
                                            if self.env.get_node_path():
                                                self.terminal.add_log("正在安装依赖...")
                                                def on_npm_complete(process):
                                                    if process.returncode == 0:
                                                        self.terminal.add_log("依赖安装成功")
                                                    else:
                                                        self.terminal.add_log("依赖安装失败")
                                                
                                                process = self.execute_command(f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", "SillyTavern")
                                                if process:
                                                    def wait_for_process():
                                                        # 等待异步进程完成
                                                        process_obj = None
                                                        if asyncio.iscoroutine(process):
                                                            # 正确处理协程对象
                                                            loop = asyncio.new_event_loop()
                                                            asyncio.set_event_loop(loop)
                                                            try:
                                                                process_obj = loop.run_until_complete(process)
                                                                loop.run_until_complete(process_obj.wait())
                                                            finally:
                                                                loop.close()
                                                                asyncio.set_event_loop(None)
                                                        else:
                                                            process_obj = process
                                                            process_obj.wait()
                                                        on_npm_complete(process_obj)
                                                    
                                                    threading.Thread(target=wait_for_process,daemon=True).start()
                                            else:
                                                self.terminal.add_log("未找到nodejs")
                                        else:
                                            self.terminal.add_log("重试更新失败")
                                    
                                    threading.Thread(target=wait_for_retry_process, daemon=True).start()
                                else:
                                    self.terminal.add_log("重试更新失败")
                            else:
                                self.terminal.add_log("无法解决package-lock.json冲突，需要手动处理")
                        except Exception as ex:
                            self.terminal.add_log(f"处理package-lock.json冲突时出错: {str(ex)}")
            
                process = self.execute_command(f'\"{git_path}git\" pull --rebase --autostash', "SillyTavern")
                
                # 添加git操作完成后的回调
                if process:
                    def wait_for_process():
                        # 等待异步进程完成
                        process_obj = None
                        if asyncio.iscoroutine(process):
                            # 正确处理协程对象
                            loop = asyncio.new_event_loop()
                            asyncio.set_event_loop(loop)
                            try:
                                process_obj = loop.run_until_complete(process)
                                loop.run_until_complete(process_obj.wait())
                            finally:
                                loop.close()
                                asyncio.set_event_loop(None)
                        else:
                            process_obj = process
                            process_obj.wait()
                        on_git_complete(process_obj)
                    
                    threading.Thread(target=wait_for_process,daemon=True).start()
            else:
                self.terminal.add_log("未找到Git路径，请手动更新SillyTavern")

    def update_sillytavern_with_callback(self, e):
        """
        更新SillyTavern并在完成后自动启动
        """
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
                                        cache_process = self.execute_command(
                                            f"\"{self.env.get_node_path()}npm\" cache clean --force",
                                            "SillyTavern"
                                        )
                                        if cache_process:
                                            # 等待异步进程完成
                                            if asyncio.iscoroutine(cache_process):
                                                # 正确处理协程对象
                                                loop = asyncio.new_event_loop()
                                                asyncio.set_event_loop(loop)
                                                try:
                                                    process_obj = loop.run_until_complete(cache_process)
                                                    loop.run_until_complete(process_obj.wait())
                                                finally:
                                                    loop.close()
                                                    asyncio.set_event_loop(None)
                                            else:
                                                cache_process.wait()
                                        # 删除node_modules
                                        node_modules_path = os.path.join(self.env.st_dir, "node_modules")
                                        if os.path.exists(node_modules_path):
                                            try:
                                                import shutil
                                                shutil.rmtree(node_modules_path)
                                            except Exception as ex:
                                                self.terminal.add_log(f"删除node_modules失败: {str(ex)}")
                                        # 重新安装依赖
                                        retry_process = self.execute_command(
                                            f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com",
                                            "SillyTavern"
                                        )
                                        if retry_process:
                                            def on_retry_complete(p):
                                                # 等待异步进程完成
                                                process_obj = None
                                                if asyncio.iscoroutine(retry_process):
                                                    # 正确处理协程对象
                                                    loop = asyncio.new_event_loop()
                                                    asyncio.set_event_loop(loop)
                                                    try:
                                                        process_obj = loop.run_until_complete(retry_process)
                                                        loop.run_until_complete(process_obj.wait())
                                                    finally:
                                                        loop.close()
                                                        asyncio.set_event_loop(None)
                                                else:
                                                    process_obj = retry_process
                                                    process_obj.wait()
                                                on_npm_complete(process_obj, npm_retry_count + 1)
                                            
                                            threading.Thread(
                                                target=on_retry_complete,
                                                args=(retry_process,),
                                                daemon=True
                                            ).start()
                                    else:
                                        self.terminal.add_log("依赖安装失败，正在启动SillyTavern...")
                                        self.start_sillytavern(None)
                            
                            process = self.execute_command(
                                f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                "SillyTavern"
                            )
                            
                            if process:
                                def wait_for_process():
                                    # 等待异步进程完成
                                    process_obj = None
                                    if asyncio.iscoroutine(process):
                                        # 正确处理协程对象
                                        loop = asyncio.new_event_loop()
                                        asyncio.set_event_loop(loop)
                                        try:
                                            process_obj = loop.run_until_complete(process)
                                            loop.run_until_complete(process_obj.wait())
                                        finally:
                                            loop.close()
                                            asyncio.set_event_loop(None)
                                    else:
                                        process_obj = process
                                        process_obj.wait()
                                    on_npm_complete(process_obj, 0)
                                
                                threading.Thread(
                                    target=wait_for_process,
                                    daemon=True
                                ).start()
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
                                    retry_process = self.execute_command(
                                        f'\"{git_path}git\" pull --rebase --autostash', 
                                        "SillyTavern"
                                    )
                                    
                                    if retry_process:
                                        def wait_for_retry_process():
                                            # 等待异步进程完成
                                            process_obj = None
                                            if asyncio.iscoroutine(retry_process):
                                                # 正确处理协程对象
                                                loop = asyncio.new_event_loop()
                                                asyncio.set_event_loop(loop)
                                                try:
                                                    process_obj = loop.run_until_complete(retry_process)
                                                    loop.run_until_complete(process_obj.wait())
                                                finally:
                                                    loop.close()
                                                    asyncio.set_event_loop(None)
                                            else:
                                                process_obj = retry_process
                                                process_obj.wait()
                                            # 避免递归调用，直接处理结果
                                            if process_obj.returncode == 0:
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
                                                                cache_process = self.execute_command(
                                                                    f"\"{self.env.get_node_path()}npm\" cache clean --force",
                                                                    "SillyTavern"
                                                                )
                                                                if cache_process:
                                                                    # 等待异步进程完成
                                                                    if asyncio.iscoroutine(cache_process):
                                                                        # 正确处理协程对象
                                                                        loop = asyncio.new_event_loop()
                                                                        asyncio.set_event_loop(loop)
                                                                        try:
                                                                            process_obj = loop.run_until_complete(cache_process)
                                                                            loop.run_until_complete(process_obj.wait())
                                                                        finally:
                                                                            loop.close()
                                                                            asyncio.set_event_loop(None)
                                                                    else:
                                                                        cache_process.wait()
                                                                # 删除node_modules
                                                                node_modules_path = os.path.join(self.env.st_dir, "node_modules")
                                                                if os.path.exists(node_modules_path):
                                                                    try:
                                                                        import shutil
                                                                        shutil.rmtree(node_modules_path)
                                                                    except Exception as ex:
                                                                        self.terminal.add_log(f"删除node_modules失败: {str(ex)}")
                                                                # 重新安装依赖
                                                                retry_process = self.execute_command(
                                                                    f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com",
                                                                    "SillyTavern"
                                                                )
                                                                if retry_process:
                                                                    def on_retry_complete(p):
                                                                        # 等待异步进程完成
                                                                        process_obj = None
                                                                        if asyncio.iscoroutine(retry_process):
                                                                            # 正确处理协程对象
                                                                            loop = asyncio.new_event_loop()
                                                                            asyncio.set_event_loop(loop)
                                                                            try:
                                                                                process_obj = loop.run_until_complete(retry_process)
                                                                                loop.run_until_complete(process_obj.wait())
                                                                            finally:
                                                                                loop.close()
                                                                                asyncio.set_event_loop(None)
                                                                        else:
                                                                            process_obj = retry_process
                                                                            process_obj.wait()
                                                                        on_npm_complete(process_obj, npm_retry_count + 1)
                                                                    
                                                                    threading.Thread(
                                                                        target=on_retry_complete,
                                                                        args=(retry_process,),
                                                                        daemon=True
                                                                    ).start()
                                                            else:
                                                                self.terminal.add_log("依赖安装失败，正在启动SillyTavern...")
                                                                self.start_sillytavern(None)
                                                    
                                                    process = self.execute_command(
                                                        f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                                        "SillyTavern"
                                                    )
                                                    
                                                    if process:
                                                        def wait_for_process():
                                                            # 等待异步进程完成
                                                            process_obj = None
                                                            if asyncio.iscoroutine(process):
                                                                # 正确处理协程对象
                                                                loop = asyncio.new_event_loop()
                                                                asyncio.set_event_loop(loop)
                                                                try:
                                                                    process_obj = loop.run_until_complete(process)
                                                                    loop.run_until_complete(process_obj.wait())
                                                                finally:
                                                                    loop.close()
                                                                    asyncio.set_event_loop(None)
                                                            else:
                                                                process_obj = process
                                                                process_obj.wait()
                                                            on_npm_complete(process_obj, 0)
                                                        
                                                        threading.Thread(
                                                            target=wait_for_process,
                                                            daemon=True
                                                        ).start()
                                                else:
                                                    self.terminal.add_log("未找到nodejs，正在启动SillyTavern...")
                                                    self.start_sillytavern(None)
                                            else:
                                                # 递增retry_count并再次尝试
                                                on_git_complete(process_obj, retry_count + 1)
                                        
                                        threading.Thread(target=wait_for_retry_process, daemon=True).start()
                                    else:
                                        self.terminal.add_log("重试更新失败")
                                        self.start_sillytavern(None)
                                else:
                                    self.terminal.add_log("无法解决package-lock.json冲突，需要手动处理")
                                    self.start_sillytavern(None)
                            except Exception as ex:
                                self.terminal.add_log(f"处理package-lock.json冲突时出错: {str(ex)}")
                                self.start_sillytavern(None)
                        else:
                            self.terminal.add_log("Git更新失败，已达到最大重试次数")
                            self.start_sillytavern(None)
                
                process = self.execute_command(
                    f'\"{git_path}git\" pull --rebase --autostash', 
                    "SillyTavern"
                )
                
                # 添加git操作完成后的回调
                if process:
                    def wait_for_process():
                        # 等待异步进程完成
                        process_obj = None
                        if asyncio.iscoroutine(process):
                            # 正确处理协程对象
                            loop = asyncio.new_event_loop()
                            asyncio.set_event_loop(loop)
                            try:
                                process_obj = loop.run_until_complete(process)
                                loop.run_until_complete(process_obj.wait())
                            finally:
                                loop.close()
                                asyncio.set_event_loop(None)
                        else:
                            process_obj = process
                            process_obj.wait()
                        on_git_complete(process_obj)
                    
                    threading.Thread(
                        target=wait_for_process,
                        daemon=True
                    ).start()
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
        
        # 保存配置文件
        self.config_manager.save_config()
            
        if (self.config_manager.get("use_sys_env", False) and self.config_manager.get("patchgit", False)) or not self.config_manager.get("use_sys_env", False):
            # 处理gitconfig文件
            if self.env.git_dir and os.path.exists(self.env.git_dir):
                gitconfig_path = os.path.join(self.env.gitroot_dir, "etc", "gitconfig")
                try:
                    import configparser

                    gitconfig = configparser.ConfigParser()
                    if os.path.exists(gitconfig_path):
                        gitconfig.read(gitconfig_path)
                    
                    # 读取当前所有insteadof配置
                    current_mirrors = {}
                    for section in gitconfig.sections():
                        if 'insteadof' in gitconfig[section]:
                            target = gitconfig.get(section, 'insteadof')
                            current_mirrors[section] = target
                    
                    # 精准删除旧的GitHub镜像配置
                    for section, target in current_mirrors.items():
                        if target == "https://github.com/":
                            gitconfig.remove_section(section)
                    
                    # 添加新镜像配置（如果需要）
                    if mirror_type != "github":
                        mirror_url = f"https://{mirror_type}/https://github.com/"
                        mirror_section = f'url "{mirror_url}"'
                        if not gitconfig.has_section(mirror_section):
                            gitconfig.add_section(mirror_section)
                        gitconfig.set(mirror_section, "insteadof", "https://github.com/")
                    
                    # 写入修改后的配置
                    with open(gitconfig_path, 'w') as configfile:
                        gitconfig.write(configfile)
                        
                except Exception as ex:
                    self.terminal.add_log(f"更新gitconfig失败: {str(ex)}")

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
                while True:
                    try:
                        # 从流中读取一行
                        line = await stream.readline()
                        if not line:  # 如果没有数据且流已结束，则退出循环
                            break
                        
                        # 处理读取到的行
                        # 清理行尾的换行符和回车符
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