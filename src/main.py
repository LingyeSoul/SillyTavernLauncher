import flet as ft
from time import sleep
from env import Env
import subprocess
import threading
import os
import codecs
import threading

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
    page.theme_mode="dark"
    page.window.maximizable = False
    page.window.title_bar_hidden = True
    page.window.icon= f"{os.getcwd()}\\assets\\icon.ico"

    BSytle=ft.ButtonStyle(icon_size=25,text_style=ft.TextStyle(size=20,font_family="Microsoft YaHei"))

    env=Env()
        
    terminal = Terminal()

    def exit_app(e):
        if terminal.is_running:
            terminal.stop_processes()
        page.window.visible=False
        page.window.destroy()
        
    page.appbar = ft.AppBar(
        #leading=ft.Icon(ft.Icons.PALETTE),
        leading_width=40,
        title=ft.WindowDragArea(content=ft.Text("SillyTavernLauncher"), width=800),
        center_title=False,
        bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
        actions=[
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
            full_command = f"set NODE_ENV=production && {command}"
        else:
            full_command = f"export NODE_ENV=production && {command}"
            
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
                            terminal.add_log(f"[ERROR] {text}" if is_stderr else text)

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
    
    tmp=env.checkEnv()
    if not tmp==True:
        terminal.add_log("内置环境检查失败")
        
    def install_sillytavern(e):
        git_path = env.get_git_path()
        if env.checkST():
            terminal.add_log("SillyTavern已安装")
            if env.get_node_path:
                if env.check_nodemodules():
                    terminal.add_log("依赖项已安装")
                else:
                    execute_command(f"{env.get_node_path()}npm install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", "SillyTavern")
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
                execute_command(f'{git_path}git clone {repo_url} -b release', ".")
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
                process = execute_command(f"{env.get_node_path()}node server.js %*", "SillyTavern")
                if process:
                    def wait_for_exit():
                        process.wait()
                        on_process_exit()
                    
                    threading.Thread(target=wait_for_exit, daemon=True).start()

    def stop_sillytavern(e):
        terminal.add_log("正在停止SillyTavern进程...")
        terminal.stop_processes()
        terminal.add_log("所有进程已停止")

    def update_sillytavern(e):
        git_path = env.get_git_path()
        if env.checkST():
            terminal.add_log("正在更新SillyTavern...")
            if git_path:
                # 链式执行更新命令
                def on_git_complete():
                    if env.get_node_path:
                        terminal.add_log("Git更新完成，正在安装依赖...")
                        execute_command(f"{env.get_node_path()}npm install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com", "SillyTavern")
                    else:
                        terminal.add_log("未找到nodejs")
                
                execute_command(
                    f'{git_path}git pull --rebase --autostash', 
                    "SillyTavern",
                )
            else:
                terminal.add_log("未找到Git路径，请手动更新SillyTavern")
    # 创建设置页面
    settings_view = ft.Column([
        ft.Text("设置", size=24, weight=ft.FontWeight.BOLD),
        ft.Divider(),
        ft.Text("GitHub镜像源选择", size=18, weight=ft.FontWeight.BOLD),
        ft.Text("推荐使用镜像站获得更好的下载速度", size=14, color=ft.Colors.GREY_600),
        ft.Divider(height=10),
        ft.RadioGroup(
            content=ft.Column([
                ft.Radio(value="github", label="官方源 (github.com) - 可能较慢", ),
                ft.Radio(value="github_mirror", label="推荐镜像 (github.moeyy.xyz) - 速度更快",),
            ], spacing=10),
            value=page.client_storage.get("github.mirror") or "github_mirror",
            on_change=lambda e: update_mirror_setting(e.control.value)
        ),
        ft.Divider(height=20),
        ft.Text("切换后新任务将立即生效", size=14, color=ft.Colors.BLUE_400)
    ], spacing=15, expand=True)

    def update_mirror_setting(mirror_type):
        # 保存设置到客户端存储
        page.client_storage.set("github.mirror", mirror_type)

    # 创建关于页面
    about_view = ft.Column([
        ft.Text("关于", size=24, weight=ft.FontWeight.BOLD),
        ft.Divider(),
        ft.Text("SillyTavernLauncher", size=20, weight=ft.FontWeight.BOLD),
        ft.Text("版本: 1.0.0", size=16),
        ft.Text("作者: 泠夜Soul", size=16),
        ft.ElevatedButton(
            "访问GitHub仓库",
            icon=ft.Icons.OPEN_IN_BROWSER,
            on_click=lambda e: e.page.launch_url("https://github.com/SillyTavern/SillyTavern", web_window_name="github"),
            style=BSytle,
            height=40
        ),
        ft.ElevatedButton(
            "访问作者B站",
            icon=ft.Icons.OPEN_IN_BROWSER,
            on_click=lambda e: e.page.launch_url("https://space.bilibili.com/298721157", web_window_name="bilibili"),
            style=BSytle,
            height=40
        )
    ], spacing=20, expand=True)

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
    


ft.app(target=main, view=ft.AppView.FLET_APP_HIDDEN)
