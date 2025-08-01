import threading
import json
import os
import flet as ft
from env import Env
from sysenv import SysEnv
from stconfig import stcfg
import subprocess
import codecs


class UiEvent:
    def __init__(self, page, terminal):
        self.page = page
        self.terminal = terminal
        self.config_path = os.path.join(os.getcwd(),"config.json")
        # 读取配置文件
        if not os.path.exists(self.config_path):
            with open(self.config_path, "w") as f:
                json.dump({
                    "patchgit": False,
                    "use_sys_env": self.envCheck(),
                    "theme": "dark",
                    "first_run": True,
                    "github": {"mirror": "gh.llkk.cc"}
                }, f, indent=4)
        
        with open(self.config_path, "r") as f:
            self.config = json.load(f)
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

    def envCheck(self):
        if os.path.exists(os.path.join(os.getcwd(), "env\\")):
            return False
        else:
            return True
        
    def exit_app(self, e):
        if self.terminal.is_running:
            self.terminal.stop_processes()
        self.page.window.visible = False
        self.page.window.destroy()

    def switch_theme(self, e):
        if self.page.theme_mode == "light":
            e.control.icon = "SUNNY"
            self.page.theme_mode = "dark"
            self.config["theme"] = "dark"
        else:
            e.control.icon = "MODE_NIGHT"
            self.page.theme_mode = "light"
            self.config["theme"] = "light"
        
        # 保存配置
        with open(self.config_path, "w") as f:
            json.dump(self.config, f, indent=4)
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
                                threading.Thread(
                                    target=lambda: (retry_process.wait(), on_retry_complete(retry_process)),
                                    daemon=True
                                ).start()
                    
                    process = self.execute_command(
                        f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                        "SillyTavern"
                    )
                    
                    if process:
                        threading.Thread(
                            target=lambda: (process.wait(), on_npm_complete(process)),
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
                                        threading.Thread(
                                            target=lambda: (retry_process.wait(), on_retry_complete(retry_process)),
                                            daemon=True
                                        ).start()
                            process = self.execute_command(
                                f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                "SillyTavern"
                            )
                            
                            if process:
                                threading.Thread(
                                    target=lambda: (process.wait(), on_npm_complete(process)),
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
                    threading.Thread(
                        target=lambda: (process.wait(), on_git_complete(process)),
                        daemon=True
                    ).start()
            else:
                self.terminal.add_log("Error: Git路径未正确配置")

    def start_sillytavern(self,e):
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
                        process.wait()
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

    
    def update_sillytavern(self,e):
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
                                    self.terminal.add_log("依赖安装成功")
                                else:
                                    if npm_retry_count < 2:
                                        self.terminal.add_log(f"依赖安装失败，正在重试... (尝试次数: {npm_retry_count + 1}/2)")
                                        # 清理npm缓存
                                        cache_process = self.execute_command(
                                            f"\"{self.env.get_node_path()}npm\" cache clean --force",
                                            "SillyTavern"
                                        )
                                        if cache_process:
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
                                            threading.Thread(
                                                target=lambda: (retry_process.wait(), on_retry_complete(retry_process)),
                                                daemon=True
                                            ).start()
                                    else:
                                        self.terminal.add_log("依赖安装失败")
                            
                            process = self.execute_command(
                                f"\"{self.env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                "SillyTavern"
                            )
                            
                            if process:
                                threading.Thread(
                                    target=lambda: (process.wait(), on_npm_complete(process)),
                                    daemon=True
                                ).start()
                        else:
                            self.terminal.add_log("未找到nodejs")
                    else:
                        if retry_count < 2:
                            self.terminal.add_log(f"Git更新失败，正在重试... (尝试次数: {retry_count + 1}/2)")
                            # 重新执行git pull
                            retry_process = self.execute_command(
                                f'\"{git_path}git\" pull --rebase --autostash', 
                                "SillyTavern"
                            )
                            if retry_process:
                                def on_retry_complete(p):
                                    on_git_complete(p, retry_count + 1)
                                threading.Thread(
                                    target=lambda: (retry_process.wait(), on_retry_complete(retry_process)),
                                    daemon=True
                                ).start()
                        else:
                            self.terminal.add_log("Git更新失败，跳过依赖安装")
                
                process = self.execute_command(
                    f'\"{git_path}git\" pull --rebase --autostash', 
                    "SillyTavern"
                )
                
                # 添加git操作完成后的回调
                if process:
                    def wait_and_callback():
                        process.wait()
                        on_git_complete(process)
                    
                    threading.Thread(target=wait_and_callback, daemon=True).start()
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

    def proxy_url_changed(self,e):
        self.stCfg.proxy_url = e.control.value
        self.stCfg.save_config()
        self.showMsg('配置文件已保存')
        
    def proxy_changed(self,e):
        self.stCfg.proxy_enabled = e.control.value
        self.stCfg.save_config()
        self.showMsg('配置文件已保存')
        
    def env_changed(self,e):
        self.config["use_sys_env"] = e.control.value
        if e.control.value:
            self.env = SysEnv()
        else:
            self.env = Env()
        
        # 保存配置
        with open(self.config_path, "w") as f:
            json.dump(self.config, f, indent=4)
        self.showMsg('环境设置已保存')
    
    def patchgit_changed(self,e):
        self.config["patchgit"] = e.control.value
        # 保存配置
        with open(self.config_path, "w") as f:
            json.dump(self.config, f, indent=4)
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
            
    def showMsg(self, msg):
        self.page.open(ft.SnackBar(ft.Text(msg), show_close_icon=True, duration=3000))

    def update_mirror_setting(self, e):
        mirror_type = e.data  # DropdownM2使用data属性获取选中值
        # 保存设置到配置文件
        if "github" not in self.config:
            self.config["github"] = {}
        self.config["github"]["mirror"] = mirror_type
        
        # 保存配置文件
        with open(self.config_path, "w") as f:
            json.dump(self.config, f, indent=4)
            
        if (self.config.get("use_sys_env", False) and self.config.get("patchgit", False)) or not self.config.get("use_sys_env", False):
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

    def execute_command(self, command: str, workdir: str = "SillyTavern"):
        import os
        import platform
        try:
        # 根据操作系统设置环境变量
            if platform.system() == "Windows":
                # 确保工作目录存在
                if not os.path.exists(workdir):
                    os.makedirs(workdir)
                
                # 构建环境变量字典
                env = os.environ.copy()
                env['NODE_ENV'] = 'production'
                if not self.config.get("use_sys_env", False):
                    node_path = self.env.get_node_path().replace('\\', '/')
                    git_path = self.env.get_git_path().replace('\\', '/')
                    env['PATH'] = f"{node_path};{git_path};{env.get('PATH', '')}"

                self.terminal.add_log(f"{workdir} $ {command}")
                # 启动进程并记录(优化Windows参数)
                process = subprocess.Popen(
                    command,  # 直接执行原始命令
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=workdir,
                    encoding='utf-8',
                    env=env,  # 使用自定义环境变量
                    creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
                    universal_newlines=False
                )
                self.terminal.active_processes.append({
                    'process': process,
                    'pid': process.pid,
                    'command': command
                })
            
            # 读取输出
            def read_output(pipe, is_stderr=False):
                # 使用增量解码器处理多字节字符
                decoder = codecs.getincrementaldecoder('utf-8')()
                while True:
                    try:
                        # 明确读取字节数据
                        chunk = pipe.readline()
                        if not chunk:
                            break

                        # 确保处理的是字节流
                        if isinstance(chunk, str):
                            chunk = chunk.encode('utf-8', errors='replace')

                        # 优先尝试UTF-8解码
                        text = decoder.decode(chunk)
                        if text:
                            self.terminal.add_log(f"{text}" if is_stderr else text)

                    except UnicodeDecodeError as e:
                        # 添加空值检查
                        if 'chunk' not in locals():
                            continue
                            
                        # 重置解码器
                        decoder = codecs.getincrementaldecoder('utf-8')()
                        try:
                            # 尝试GBK解码并处理可能的截断
                            text = chunk.decode('gbk', errors='ignore')
                            self.terminal.add_log(f"[GBK解码] {text}")
                        except UnicodeDecodeError:
                            # 最终尝试latin1解码并处理可能的截断
                            text = chunk.decode('latin1', errors='ignore')
                            self.terminal.add_log(f"[LATIN1解码] {text}")

                    except Exception as ex:
                        if hasattr(self.terminal, 'view') and self.terminal.view.page:
                            self.terminal.add_log(f"输出处理错误: {type(ex).__name__}: {str(ex)}")
                        break

                # 处理剩余缓冲区
                remaining = decoder.decode(b'')
                if remaining and hasattr(self.terminal, 'view') and self.terminal.view.page:
                    self.terminal.add_log(f"[FINAL] {remaining}")

            # 创建并启动输出处理线程
            stdout_thread = threading.Thread(
                target=read_output, 
                args=(process.stdout, False),
                daemon=True
            )
            stderr_thread = threading.Thread(
                target=read_output, 
                args=(process.stderr, True),
                daemon=True
            )
            
            stdout_thread.start()
            stderr_thread.start()
            
            # 保存线程引用以便后续管理
            self.terminal._output_threads.append(stdout_thread)
            self.terminal._output_threads.append(stderr_thread)
            
            return process
        except Exception as e:
            self.terminal.add_log(f"Error: {str(e)}")
            return None