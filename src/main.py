import flet as ft
from time import sleep
from env import Env
from sysenv import SysEnv
from stconfig import stcfg
import subprocess
import threading
import os
import codecs


class Terminal:
    def __init__(self):
        self.logs = ft.ListView(
            expand=True,
            spacing=5,
            auto_scroll=True,
            padding=10
        )
        self.view = ft.Column([
            ft.Text("终端", size=24, weight=ft.FontWeight.BOLD),
            ft.Container(
                content=self.logs,
                border=ft.border.all(1, ft.Colors.GREY_400),
                padding=10,
                width=730,
                height=440,
            )
        ])
        self.active_processes = []
        self.is_running = False  # 添加运行状态标志
        self._output_threads = []  # 存储输出处理线程

    
    def stop_processes(self):
        """停止所有由execute_command启动的进程"""
        self.add_log("正在终止所有进程...")
        
        # 标记为不再运行
        self.is_running = False
        
        # 首先停止所有输出线程
        for thread in self._output_threads:
            if thread.is_alive():
                thread.join(timeout=1.0)
        
        self._output_threads = []
        env=Env()
        # 使用平台特定方式终止进程
        for proc_info in self.active_processes[:]:  # 使用副本避免遍历时修改
            try:
                process = proc_info['process']
                if process.poll() is None:  # 检查进程是否仍在运行
                    self.add_log(f"终止进程 {proc_info['pid']}: {proc_info['command']}")
                    
                        # 使用PowerShell递归终止进程树
                    subprocess.run(
                            f"powershell.exe -Command \"Get-CimInstance Win32_Process -Filter 'ParentProcessId={proc_info['pid']}' | Select-Object -ExpandProperty Handle | ForEach-Object {{ Stop-Process -Id $_ -Force }}\"",
                            shell=True,
                            stderr=subprocess.PIPE,
                        )
                        # 最终强制终止主进程
                    subprocess.run(
                            f"taskkill /F /PID {proc_info['pid']}",
                            shell=True,
                            stderr=subprocess.PIPE
                        )
                    subprocess.run(
                            f"powershell.exe -Command \"Get-Process | Where-Object {{ $_.Path -eq '{env.get_node_path}\\node.exe'}} | Stop-Process -Force",
                            shell=True,
                            stderr=subprocess.PIPE
                        )
                    # 等待进程终止
                    try:
                        process.wait(timeout=2.0)
                    except subprocess.TimeoutExpired:
                        self.add_log(f"进程 {proc_info['pid']} 未能及时终止")
            except Exception as ex:
                self.add_log(f"终止进程时出错: {str(ex)}")
        
        # 清空进程列表
        self.active_processes = []
        self.add_log("所有进程已终止")
        return True

    def add_log(self, text: str):
        """线程安全的日志添加方法"""
        try:
            # 限制单条日志长度并清理多余换行
            text = str(text)[:1000] if text else ""
            # 使用正则合并连续空行
            import re
            text = re.sub(r'(\r?\n){3,}', '\n\n', text.strip())
            new_text = ft.Text(text, selectable=True)
            
            async def update_ui():
                self.logs.controls.append(new_text)
                # 更严格的日志数量限制
                if len(self.logs.controls) > 800:
                    self.logs.controls = self.logs.controls[-400:]
                self.logs.scroll_to(offset=float("inf"), duration=100)
                self.logs.update()
            
            # 确保在主线程中更新UI
            if hasattr(self, 'view') and self.view.page is not None:
                self.view.page.run_task(update_ui)
        except Exception as e:
            print(f"日志添加失败: {str(e)}")

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
                    # 移除行尾可能的多余换行
                    text = text.rstrip('\r\n')
                    terminal.add_log(f"[ERROR] {text}" if is_stderr else text)

            except UnicodeDecodeError:
                # 重置解码器
                decoder = codecs.getincrementaldecoder('utf-8')()
                try:
                    # 尝试GBK解码
                    text = chunk.decode('gbk')
                    # 清理解码后的文本
                    terminal.add_log(f"[GBK解码] {text.rstrip('\r\n')}")
                except UnicodeDecodeError:
                    # 最终尝试latin1解码
                    text = chunk.decode('latin1')
                    terminal.add_log(f"[LATIN1解码] {text.rstrip('\r\n')}")

            except Exception as ex:
                if hasattr(terminal, 'view') and terminal.view.page:
                    terminal.add_log(f"输出处理错误: {type(ex).__name__}: {str(ex)}")
                break

        # 处理剩余缓冲区
        remaining = decoder.decode(b'')
        if remaining and hasattr(terminal, 'view') and terminal.view.page:
            terminal.add_log(f"[FINAL] {remaining.rstrip('\r\n')}")

def main(page: ft.Page):
    page.window.center()
    page.window.visible = True
    page.title = "SillyTavernLauncher"
    page.theme = ft.Theme(color_scheme_seed=ft.Colors.BLUE,font_family="Microsoft YaHei")
    page.dark_theme=ft.Theme(color_scheme_seed=ft.Colors.BLUE,font_family="Microsoft YaHei")
    page.window.width = 800
    page.window.height = 640
    page.window.resizable = False
    page.window.min_height=640
    page.window.min_width=800
    page.window.maximizable = False
    page.window.title_bar_hidden = True
    
    def showMsg(v):
        page.open(ft.SnackBar(ft.Text(v),show_close_icon=True,duration=3000))

    BSytle=ft.ButtonStyle(icon_size=25,text_style=ft.TextStyle(size=20,font_family="Microsoft YaHei"))

    env=Env()
    stCfg=stcfg()
    terminal = Terminal()

    def exit_app(e):
        if terminal.is_running:
            terminal.stop_processes()
        page.window.visible=False
        page.window.destroy()

    if not page.client_storage.get("use_sys_env"):
        if not os.path.exists(env.base_dir):
            page.client_storage.set("use_sys_env", True)
        else:
            page.client_storage.set("use_sys_env", False)
    use_sys_env = page.client_storage.get("use_sys_env")
    if use_sys_env:
        env=SysEnv()
    if not page.client_storage.get("theme"):
        page.client_storage.set("theme", "dark")
    page.theme_mode = page.client_storage.get("theme")
    if not page.client_storage.get("theme") == "light":
        themeIcon=ft.Icons.SUNNY
    else:
        themeIcon=ft.Icons.MODE_NIGHT
    def switch_theme(e):
        if page.theme_mode == "light":
            e.control.icon = "SUNNY"
            page.theme_mode = "dark"
            page.client_storage.set("theme","dark")
        else:
            e.control.icon = "MODE_NIGHT"
            page.theme_mode = "light"
            page.client_storage.set("theme","light")
        page.update()

    page.appbar = ft.AppBar(
        #leading=ft.Icon(ft.Icons.PALETTE),
        leading_width=40,
        title=ft.WindowDragArea(content=ft.Text("SillyTavernLauncher"), width=800),
        center_title=False,
        bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
        actions=[
            ft.IconButton(icon=themeIcon,on_click=switch_theme,icon_size=30),
            ft.IconButton(ft.Icons.CANCEL_OUTLINED,on_click=exit_app,icon_size=30),
        ],
    )


    def window_event(e):
        if e.data == "close":
            exit_app(e)
    page.window.prevent_close = True
    page.window.on_event = window_event


    def execute_command(command: str, workdir: str = "SillyTavern"):
        import os
        import platform
        
        # 根据操作系统设置环境变量
        if platform.system() == "Windows":
            if use_sys_env:
                full_command = f"set NODE_ENV=production && {command}"
            else:
                full_command = f"set NODE_ENV=production && set PATH={env.get_git_path()};%PATH% && {command}"
            
        terminal.add_log(f"{workdir} $ {full_command}")
        try:
            # 确保工作目录存在
            if not os.path.exists(workdir):
                os.makedirs(workdir)
            
            # 启动进程并记录(使用进程组)
            process = subprocess.Popen(
                full_command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=workdir,
                encoding='utf-8',
                start_new_session=True,  # 创建新进程组
                universal_newlines=False  # 确保返回字节流
            )
            terminal.active_processes.append({
                'process': process,
                'pid': process.pid,
                'command': full_command
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
                            terminal.add_log(f"{text}" if is_stderr else text)

                    except UnicodeDecodeError:
                        # 重置解码器
                        decoder = codecs.getincrementaldecoder('utf-8')()
                        try:
                            # 尝试GBK解码
                            text = chunk.decode('gbk')
                            terminal.add_log(f"[GBK解码] {text}")
                        except UnicodeDecodeError:
                            # 最终尝试latin1解码
                            text = chunk.decode('latin1')
                            terminal.add_log(f"[LATIN1解码] {text}")

                    except Exception as ex:
                        if hasattr(terminal, 'view') and terminal.view.page:
                            terminal.add_log(f"输出处理错误: {type(ex).__name__}: {str(ex)}")
                        break

                # 处理剩余缓冲区
                remaining = decoder.decode(b'')
                if remaining and hasattr(terminal, 'view') and terminal.view.page:
                    terminal.add_log(f"[FINAL] {remaining}")

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
            terminal._output_threads.append(stdout_thread)
            terminal._output_threads.append(stderr_thread)
            
            return process
        except Exception as e:
            terminal.add_log(f"Error: {str(e)}")
            return None
    
    
        
    def install_sillytavern(e):
        git_path = env.get_git_path()
        if env.checkST():
            terminal.add_log("SillyTavern已安装")
            if env.get_node_path():
                if env.check_nodemodules():
                    terminal.add_log("依赖项已安装")
                else:
                    terminal.add_log("正在安装依赖...")
                    def on_npm_complete(process):
                        if process.returncode == 0:
                            terminal.add_log("依赖安装成功")
                        else:
                            terminal.add_log("依赖安装失败")
                    
                    process = execute_command(
                        f"\"{env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                        "SillyTavern"
                    )
                    
                    if process:
                        threading.Thread(
                            target=lambda: (process.wait(), on_npm_complete(process)),
                            daemon=True
                        ).start()
            else:
                terminal.add_log("未找到nodejs")
        else:
            if git_path:
                # 从客户端存储获取镜像设置
                mirror_type = page.client_storage.get("github.mirror") or "github"
                if mirror_type == "github_mirror":
                    repo_url = "https://github.moeyy.xyz/https://github.com/SillyTavern/SillyTavern"
                else:
                    repo_url = "https://github.com/SillyTavern/SillyTavern"
                
                terminal.add_log("正在安装SillyTavern...")
                def on_git_complete(process):
                    if process.returncode == 0:
                        terminal.add_log("安装成功")
                        if env.get_node_path():
                            terminal.add_log("正在安装依赖...")
                            def on_npm_complete(process):
                                if process.returncode == 0:
                                    terminal.add_log("依赖安装成功")
                                else:
                                    terminal.add_log("依赖安装失败")
                            
                            process = execute_command(
                                f"\"{env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                "SillyTavern"
                            )
                            
                            if process:
                                threading.Thread(
                                    target=lambda: (process.wait(), on_npm_complete(process)),
                                    daemon=True
                                ).start()
                        else:
                            terminal.add_log("未找到nodejs")
                    else:
                        terminal.add_log("安装失败")
                
                process = execute_command(
                    f'\"{git_path}git\" clone {repo_url} -b release', 
                    "."
                )
                
                if process:
                    threading.Thread(
                        target=lambda: (process.wait(), on_git_complete(process)),
                        daemon=True
                    ).start()
            else:
                terminal.add_log("Error: Git路径未正确配置")

    def start_sillytavern(e):
        if terminal.is_running:
            terminal.add_log("SillyTavern已经在运行中")
            return
            
        if env.checkST():
            if env.check_nodemodules():
                terminal.is_running = True
                def on_process_exit():
                    terminal.is_running = False
                    terminal.add_log("SillyTavern进程已退出")
                
                # 启动进程并设置退出回调
                process = execute_command(f"\"{env.get_node_path()}node\" server.js %*", "SillyTavern")
                if process:
                    def wait_for_exit():
                        process.wait()
                        on_process_exit()
                    
                    threading.Thread(target=wait_for_exit, daemon=True).start()
                    terminal.add_log("SillyTavern已启动")
                else:
                    terminal.add_log("启动失败")
            else:
                terminal.add_log("依赖项未安装")
        else:
            terminal.add_log("SillyTavern未安装")

    def stop_sillytavern(e):
        terminal.add_log("正在停止SillyTavern进程...")
        terminal.stop_processes()
        terminal.add_log("所有进程已停止")

    def check_for_updates_in_thread():
        import requests
        import json
        from urllib.parse import urlparse
        
        # 多个GitHub API镜像源
        MIRRORS = [
            "https://api.github.com",
            "https://gh.llkk.cc/https://api.github.com",
        ]
        
        # 本地版本(硬编码，实际项目中应该从配置或文件中读取)
        local_version = "0.0.0"
        
        latest_version = None
        release_url = None
        last_error = None
        
        # 尝试多个镜像源
        for mirror in MIRRORS:
            api_url = f"{mirror}/repos/LingyeSoul/SillyTavernLauncher/releases/latest"
            try:
                terminal.add_log(f"正在尝试从 {urlparse(mirror).netloc} 检查更新...")
                
                # 获取最新发布版本
                headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3"
}

                response = requests.get(api_url, timeout=15,headers=headers)
                response.raise_for_status()
                
                latest_release = response.json()
                latest_version = latest_release["tag_name"]
                release_url = latest_release["html_url"]
                last_error = None
                break
                
            except requests.exceptions.RequestException as ex:
                last_error = str(ex)
                terminal.add_log(f"镜像 {urlparse(mirror).netloc} 检查失败: {str(ex)}")
                continue
                
        if latest_version is None:
            terminal.add_log(f"所有镜像源检查更新失败，最后错误: {last_error}")
            return
            
        try:
            if latest_version != local_version:
                # 在主线程中显示更新提示对话框
                def show_update_dialog():
                    def open_github(e):
                        page.launch_url(release_url, web_window_name="github_release")
                    dig= ft.AlertDialog(
                        title=ft.Text("发现新版本"),
                        content=ft.Text(f"最新版本: {latest_version}\n当前版本: {local_version}"),
                        actions=[
                            ft.TextButton("前往下载", on_click=open_github),
                            ft.TextButton("取消", on_click=lambda e: page.close(dig))
                        ],
                        actions_alignment=ft.MainAxisAlignment.END
                    )
                    page.open(dig)
                    terminal.add_log(f"发现新版本 {latest_version} (当前: {local_version})")
                
            else:
                terminal.add_log(f"当前已是最新版本 ({local_version})")
                
        except Exception as ex:
            terminal.add_log(f"显示更新对话框失败: {str(ex)}")

    def check_for_updates(e):
        check_for_updates_in_thread()
    
    
    def update_sillytavern(e):
        git_path = env.get_git_path()
        if env.checkST():
            terminal.add_log("正在更新SillyTavern...")
            if git_path:
                # 执行git pull
                def on_git_complete(process):
                    if process.returncode == 0:
                        terminal.add_log("Git更新成功")
                        if env.get_node_path():
                            terminal.add_log("正在安装依赖...")
                            def on_npm_complete(process):
                                if process.returncode == 0:
                                    terminal.add_log("依赖安装成功")
                                else:
                                    terminal.add_log("依赖安装失败")
                            
                            process = execute_command(
                                f"\"{env.get_node_path()}npm\" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", 
                                "SillyTavern"
                            )
                            
                            if process:
                                threading.Thread(
                                    target=lambda: (process.wait(), on_npm_complete(process)),
                                    daemon=True
                                ).start()
                        else:
                            terminal.add_log("未找到nodejs")
                    else:
                        terminal.add_log("Git更新失败，跳过依赖安装")
                
                process = execute_command(
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
                terminal.add_log("未找到Git路径，请手动更新SillyTavern")


    def port_changed(e):
        stCfg.port= e.control.value
        stCfg.save_config()
        showMsg('配置文件已保存')
    def listen_changed(e):
        stCfg.listen = e.control.value 
        stCfg.save_config()
        showMsg('配置文件已保存')
    def env_changed(e):
        page.client_storage.set('use_sys_env', e.control.value)
        if e.control.value:
            env=SysEnv()
        else:
            env=Env()
        showMsg('环境设置已保存')
    def sys_env_check(e):
        sysenv=SysEnv()
        tmp=sysenv.checkSysEnv()
        showMsg(f'{tmp} Git：{sysenv.get_git_path()} NodeJS：{sysenv.get_node_path()}')
    def in_env_check(e):
        inenv=Env()
        tmp=inenv.checkEnv()
        showMsg(f'{tmp} Git：{inenv.get_git_path()} NodeJS：{inenv.get_node_path()}')
    # 创建设置页面
    settings_view = ft.Column([
        ft.Text("设置", size=24, weight=ft.FontWeight.BOLD),
        ft.Divider(),
    ft.Column([
        ft.Text("GitHub镜像源选择", size=18, weight=ft.FontWeight.BOLD),
        ft.Text("推荐使用镜像站获得更好的下载速度", size=14, color=ft.Colors.GREY_600),
        ft.RadioGroup(
            content=ft.Column([
                ft.Radio(value="github", label="官方源 (github.com) - 可能较慢", ),
                ft.Radio(value="github_mirror", label="推荐镜像 (github.moeyy.xyz) - 速度更快",),
            ], spacing=10),
            value=page.client_storage.get("github.mirror") or "github_mirror",
            on_change=lambda e: update_mirror_setting(e.control.value)
        ),
        ft.Text("切换后新任务将立即生效", size=14, color=ft.Colors.BLUE_400),
        ft.Divider(),
        ft.Switch(
            label="使用系统环境",
            value=page.client_storage.get("use_sys_env"),
            on_change=env_changed,
              ),
        ft.Text("懒人包请勿修改此选项，除非你清楚你正在做什么！ 重启后生效", size=14, color=ft.Colors.BLUE_400),
        ft.Divider(),
        ft.Switch(
            label="启用局域网访问",
            value=stCfg.listen,
            on_change=listen_changed,
              ),
        ft.Text("开启后自动生成whitelist.txt(如有，则不会生成)，放行192.168.*.*，关闭后不会删除", size=14, color=ft.Colors.BLUE_400),
        ft.Divider(),
        ft.TextField(
        label="监听端口",
        value=stCfg.port,
        hint_text="默认端口: 8000",
        on_change=port_changed,
    ),
    ft.Divider(),
    ft.Text("辅助功能", size=18, weight=ft.FontWeight.BOLD),
    ft.Row(
        controls=[ft.ElevatedButton(
                "检查系统环境",
                icon=ft.Icons.SETTINGS,
                style=BSytle,
                on_click=sys_env_check,
                height=40
            ),
        ft.ElevatedButton(
                "检查内置环境",
                icon=ft.Icons.SETTINGS,
                style=BSytle,
                on_click=in_env_check,
                height=40
            )],spacing=5,scroll=ft.ScrollMode.AUTO),
    ], spacing=15, expand=True,scroll=ft.ScrollMode.AUTO)
    ], spacing=15, expand=True)

    def update_mirror_setting(mirror_type):
        # 保存设置到客户端存储
        page.client_storage.set("github.mirror", mirror_type)
        
        # 处理gitconfig文件
        gitconfig_path = os.path.join(env.base_dir, "etc\\gitconfig")
        try:
            import configparser

            config = configparser.ConfigParser()
            if os.path.exists(gitconfig_path):
                config.read(gitconfig_path)
            
            # 定义要添加或删除的配置
            mirror_section = 'url "https://github.moeyy.xyz/https://github.com/"'
            mirror_option = 'insteadof'
            mirror_value = 'https://github.com/'
            
            if mirror_type == "github_mirror":
                # 添加镜像配置
                if not config.has_section(mirror_section):
                    config.add_section(mirror_section)
                config.set(mirror_section, mirror_option, mirror_value)
            else:
                # 删除镜像配置
                if config.has_section(mirror_section):
                    config.remove_section(mirror_section)
            
            # 写入修改后的配置
            with open(gitconfig_path, 'w') as configfile:
                config.write(configfile)
                
        except Exception as e:
            terminal.add_log(f"更新gitconfig失败: {str(e)}")

    # 创建关于页面
    about_view = ft.Column([
        ft.Text("关于", size=24, weight=ft.FontWeight.BOLD),
        ft.Divider(),
        ft.Text("SillyTavernLauncher", size=20, weight=ft.FontWeight.BOLD),
        ft.Text("版本: 0.1.4测试版3", size=16),
        ft.Text("作者: 泠夜Soul", size=16),
        ft.ElevatedButton(
            "访问GitHub仓库",
            icon=ft.Icons.OPEN_IN_BROWSER,
            on_click=lambda e: e.page.launch_url("https://github.com/LingyeSoul/SillyTavernLauncher", web_window_name="github"),
            style=BSytle,
            height=40
        ),
        ft.ElevatedButton(
            "访问作者B站",
            icon=ft.Icons.OPEN_IN_BROWSER,
            on_click=lambda e: e.page.launch_url("https://space.bilibili.com/298721157", web_window_name="bilibili"),
            style=BSytle,
            height=40
        ),
       #ft.ElevatedButton(
        #    "检查更新",
       #     icon=ft.Icons.UPDATE,
        #    tooltip="检查GitHub Release是否有新版本",
         #   style=BSytle,
        #    on_click=lambda e: check_for_updates(e),
        #    height=40
      #  )
    ], spacing=15, expand=True)

    # 导航栏
    rail = ft.NavigationRail(
        selected_index=0,
        label_type=ft.NavigationRailLabelType.ALL,
        min_width=50,
        min_extended_width=50,
        extended=False, 
        destinations=[
            ft.NavigationRailDestination(
                icon=ft.Icons.TERMINAL,
                selected_icon=ft.Icons.TERMINAL,
                label="终端"
            ),
            ft.NavigationRailDestination(
                icon=ft.Icons.SETTINGS,
                selected_icon=ft.Icons.SETTINGS,
                label="设置"
            ),
            ft.NavigationRailDestination(
                icon=ft.Icons.INFO,
                selected_icon=ft.Icons.INFO,
                label="关于"
            ),
        ],
        on_change=lambda e: switch_view(e.control.selected_index)
    )

    # 主容器
    terminal_view=[terminal.view,
                   ft.Row(
            [ 
                        ft.ElevatedButton(
                            "安装",
                            icon=ft.Icons.DOWNLOAD,
                            tooltip="从仓库拉取最新版本并安装依赖",
                            style=BSytle,
                            on_click=lambda e: install_sillytavern(e),
                            height=50,
                        ),
                        ft.ElevatedButton(
                            "启动",
                            icon=ft.Icons.PLAY_ARROW,
                            tooltip="启动SillyTavern",
                            style=BSytle,
                            on_click=lambda e: start_sillytavern(e),
                            height=50,
                        ),
                        ft.ElevatedButton(
                            "停止",
                            icon=ft.Icons.CANCEL,
                            tooltip="停止SillyTavern",
                            style=BSytle,
                            on_click=lambda e: stop_sillytavern(e),
                            height=50,
                        ),
                        ft.ElevatedButton(
                            "更新",
                            icon=ft.Icons.UPDATE,
                            tooltip="更新到最新版本并更新依赖",
                            style=BSytle,
                            on_click=lambda e: update_sillytavern(e),
                            height=50,
                        ),
                        ],
            alignment=ft.MainAxisAlignment.CENTER,
            expand=True 
        ),
        ]
    content = ft.Column(terminal_view, expand=True)
    def switch_view(index):
        content.controls.clear()
        if index == 0:
            content.controls.extend(terminal_view)
        elif index == 1:
            content.controls.append(settings_view)
        else:
            content.controls.append(about_view)
        page.update()

    # 整体布局

    page.add(
        ft.Row(
            [   
                rail,
                ft.VerticalDivider(width=1),
                content
            ],
            expand=True,  # 确保Row扩展填充可用空间
            alignment=ft.MainAxisAlignment.SPACE_BETWEEN,  # 更好的对齐方式
            vertical_alignment=ft.CrossAxisAlignment.STRETCH  # 垂直方向拉伸
        )
    )
    #check_for_updates(None)
    if use_sys_env:
        tmp=env.checkSysEnv()
        if not tmp==True:
            terminal.add_log(tmp)
    else:    
        tmp=env.checkEnv()
        if not tmp==True:
            terminal.add_log(tmp)


ft.app(target=main, view=ft.AppView.FLET_APP_HIDDEN)
