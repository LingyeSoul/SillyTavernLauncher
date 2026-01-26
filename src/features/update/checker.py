from utils.logger import app_logger
import json
import urllib.request
import urllib.error
from config.config_manager import ConfigManager
import flet as ft
from flet import UrlLauncher
import ssl
import asyncio
import aiohttp
from version import VERSION
import threading
import re
import html

class VersionChecker:
    def __init__(self, page):
        self.config_manager = ConfigManager()
        self.current_version = VERSION
        self.page = page
        # 禁用SSL证书验证（仅在需要时使用）
        self.context = ssl.create_default_context()
        self.context.check_hostname = False
        self.context.verify_mode = ssl.CERT_NONE
    def _showMsg(self, v):
        # 使用正确的 API 显示 SnackBar（适配 Flet 0.80.1）
        self.page.show_dialog(ft.SnackBar(ft.Text(v), show_close_icon=True, duration=3000))

    async def fetch_changelog(self):
        """
        从 VitePress 页面获取更新日志

        Returns:
            str: Markdown 格式的更新日志，如果失败则返回 None
        """
        changelog_url = "https://sillytavern.lingyesoul.top/changelog.html"

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(changelog_url,
                                       headers={'User-Agent': 'SillyTavernLauncher/1.0'},
                                       timeout=aiohttp.ClientTimeout(total=15)) as response:
                    if response.status == 200:
                        html_content = await response.text()

                        # 尝试从 VitePress 页面中提取原始 Markdown
                        # VitePress 通常会在 <script> 标签中嵌入原始 Markdown
                        # 查找模式: __VP_SITE_DATA__ 或类似的数据结构

                        # 方法1: 查找 VitePress 的数据块
                        markdown_match = re.search(r'__VP_SITE_DATA__\s*=\s*({.*?});', html_content, re.DOTALL)
                        if markdown_match:
                            try:
                                import json as json_mod
                                data = json_mod.loads(markdown_match.group(1))
                                # 遍历数据查找 changelog 页面内容
                                if isinstance(data, dict):
                                    for page_path, page_data in data.items():
                                        if isinstance(page_data, dict) and 'content' in page_data:
                                            content = page_data.get('content', '')
                                            if '更新日志' in content or 'changelog' in content.lower():
                                                return content
                            except:
                                pass

                        # 方法2: 如果上面失败，尝试查找 script 标签中的纯文本 Markdown
                        # 某些 VitePress 配置可能直接在页面中包含 Markdown
                        md_match = re.search(r'<script[^>]*type="text/markdown"[^>]*>(.*?)</script>', html_content, re.DOTALL)
                        if md_match:
                            markdown_text = md_match.group(1).strip()
                            # HTML 解码
                            markdown_text = html.unescape(markdown_text)
                            return markdown_text

                        # 方法3: 如果都找不到，尝试查找页面主体内容
                        # 提取主要内容区域
                        content_match = re.search(r'<div[^>]*class="content"[^>]*>(.*?)</div>', html_content, re.DOTALL)
                        if content_match:
                            content = content_match.group(1)
                            # 移除 HTML 标签，提取纯文本
                            content = re.sub(r'<[^>]+>', '\n', content)
                            content = html.unescape(content)
                            # 简单的 Markdown 格式化
                            if '更新日志' in content or 'changelog' in content.lower():
                                return self._format_text_as_markdown(content)

                        app_logger.warning("无法从页面中提取更新日志")
                        return None
                    else:
                        app_logger.error(f"获取更新日志失败，状态码: {response.status}")
                        return None
        except Exception as e:
            app_logger.error(f"获取更新日志时出错: {e}")
            return None

    def _format_text_as_markdown(self, text):
        """
        将纯文本格式化为简单的 Markdown

        Args:
            text (str): 纯文本内容

        Returns:
            str: Markdown 格式的内容
        """
        lines = text.split('\n')
        markdown_lines = []

        for line in lines:
            line = line.strip()
            if not line:
                continue

            # 检测标题（全大写或特殊格式的行）
            if line.isupper() or re.match(r'^[A-Z\s\-]+$', line):
                level = line.count('-')
                if level > 0:
                    markdown_lines.append('#' * min(level, 3) + ' ' + line.replace('-', '').strip())
                else:
                    markdown_lines.append('## ' + line)
            # 检测列表项（以数字或特殊字符开头）
            elif re.match(r'^[\d\.\-\*]+\s', line):
                markdown_lines.append(line)
            else:
                markdown_lines.append(line)

        return '\n\n'.join(markdown_lines)

    def _parse_changelog_to_components(self, markdown_text, max_entries=3):
        """
        将 Markdown 更新日志解析为 Flet UI 组件

        Args:
            markdown_text (str): Markdown 格式的更新日志
            max_entries (int): 最多显示的版本数量

        Returns:
            list: Flet UI 组件列表
        """
        if not markdown_text:
            return [ft.Text("暂无更新日志", color=ft.Colors.GREY_500)]

        components = []
        lines = markdown_text.split('\n')
        current_version = None
        current_section = None
        current_items = []
        version_count = 0

        i = 0
        while i < len(lines) and version_count < max_entries:
            line = lines[i].strip()

            # 检测版本标题（## vX.X.X (YYYY-MM-DD)）
            version_match = re.match(r'^##\s+v?\d+\.\d+\.\d+\s*\((\d{4}-\d{2}-\d{2})\)', line)
            if version_match:
                # 保存上一个版本的内容
                if current_version and current_items:
                    components.append(self._create_version_block(current_version, current_section, current_items))
                    version_count += 1

                # 开始新版本
                current_version = line.replace('##', '').strip()
                current_section = None
                current_items = []

            # 检测章节标题（### ✨ 新增功能）
            elif line.startswith('###'):
                section_icon_map = {
                    '✨': 'new',
                    '🔧': 'improve',
                    '🐛': 'fix',
                    '📝': 'other',
                    '⚠️': 'warning'
                }

                section_title = line.replace('###', '').strip()
                current_section = section_title
                current_items = []

            # 检测列表项
            elif line.startswith('-') or line.startswith('*') or re.match(r'^\d+\.', line):
                item_text = line.lstrip('-*').lstrip('0123456789.').strip()
                if item_text:
                    current_items.append(item_text)

            i += 1

        # 添加最后一个版本
        if current_version and current_items:
            components.append(self._create_version_block(current_version, current_section, current_items))

        if not components:
            return [ft.Text("无法解析更新日志", color=ft.Colors.GREY_500)]

        return components

    def _create_version_block(self, version, section, items):
        """
        创建单个版本的 UI 块

        Args:
            version (str): 版本号和日期
            section (str): 章节标题
            items (list): 更新项列表

        Returns:
            ft.Container: 版本信息容器
        """
        # 解析版本号和日期
        version_info = version.replace('v', '').strip()
        version_match = re.match(r'([\d.]+)\s*\((\d{4}-\d{2}-\d{2})\)', version_info)

        if version_match:
            version_num = version_match.group(1)
            date_str = version_match.group(2)
        else:
            version_num = version_info
            date_str = ''

        # 确定章节颜色
        section_color_map = {
            '✨': ft.Colors.BLUE_600,
            '🔧': ft.Colors.ORANGE_600,
            '🐛': ft.Colors.RED_600,
            '📝': ft.Colors.GREY_600,
            '⚠️': ft.Colors.AMBER_600
        }

        section_color = ft.Colors.GREY_700
        for icon, color in section_color_map.items():
            if icon in section:
                section_color = color
                break

        # 构建版本块
        content_controls = [
            ft.Text(version_num, size=18, weight=ft.FontWeight.BOLD, color=ft.Colors.BLACK),
        ]

        if date_str:
            content_controls.append(ft.Text(f"发布日期: {date_str}", size=12, color=ft.Colors.GREY_600))

        content_controls.append(ft.Divider(height=10, color=ft.Colors.GREY_300))

        # 添加章节标题
        if section:
            clean_section = section
            for icon in section_color_map.keys():
                clean_section = clean_section.replace(icon, '').strip()

            content_controls.append(
                ft.Text(clean_section, size=14, weight=ft.FontWeight.W_500, color=section_color)
            )

        # 添加更新项
        for item in items[:10]:  # 最多显示10项
            # 清理 markdown 格式
            clean_item = re.sub(r'\*\*([^*]+)\*\*', r'\1', item)  # 移除粗体标记
            clean_item = clean_item.replace('`', '')  # 移除代码标记

            content_controls.append(
                ft.Text(
                    f"• {clean_item}",
                    size=12,
                    color=ft.Colors.GREY_800,
                    selectable=True
                )
            )

        return ft.Container(
            content=ft.Column(content_controls, tight=True),
            padding=10,
            border=ft.border.all(1, ft.Colors.GREY_300),
            border_radius=5,
            margin=ft.Margin.only(bottom=10)
        )

    async def run_check(self):
        result = await self.check_for_updates()

        if result["has_error"]:
            self._showMsg(f"检查更新失败: {result['error_message']}")
        elif result["has_update"]:
            # 检查是否为测试版
            if self.is_beta_version(result['latest_version']):
                # 测试版，显示简单的更新对话框
                async def open_download_page(e):
                    await UrlLauncher().launch_url("https://sillytavern.lingyesoul.top/update.html")

                update_dialog = ft.AlertDialog(
                    title=ft.Text("发现新版本（测试版）"),
                    content=ft.Column([
                        ft.Text(f"当前版本: {result['current_version']}", size=14),
                        ft.Text(f"最新版本: {result['latest_version']}", size=14),
                        ft.Text("这是一个测试版本，建议谨慎更新。", size=14, color=ft.Colors.AMBER_600),
                    ], width=400, height=150),
                    actions=[
                        ft.TextButton("前往下载", on_click=open_download_page),
                        ft.TextButton("稍后提醒", on_click=lambda e: self.page.pop_dialog()),
                    ],
                    actions_alignment=ft.MainAxisAlignment.END,
                )
                self.page.show_dialog(update_dialog)
            else:
                # 正式版，显示更新日志
                async def open_download_page(e):
                    await UrlLauncher().launch_url("https://sillytavern.lingyesoul.top/update.html")

                # 获取更新日志
                changelog_components = []
                changelog_markdown = await self.fetch_changelog()

                if changelog_markdown:
                    try:
                        changelog_components = self._parse_changelog_to_components(changelog_markdown, max_entries=3)
                    except Exception as e:
                        app_logger.error(f"解析更新日志时出错: {e}")
                        changelog_components = []

                # 构建对话框内容
                dialog_content = [
                    ft.Text(f"当前版本: {result['current_version']}", size=14),
                    ft.Text(f"最新版本: {result['latest_version']}", size=14),
                    ft.Divider(height=20),
                ]

                if changelog_components:
                    dialog_content.extend([
                        ft.Text("更新日志:", size=16, weight=ft.FontWeight.BOLD),
                        ft.Container(height=10),
                    ])
                    dialog_content.extend(changelog_components)
                else:
                    dialog_content.append(
                        ft.Text("建议更新到最新版本以获得更好的体验和新功能。", size=14)
                    )

                # 创建可滚动的内容区域
                content_column = ft.Column(
                    dialog_content,
                    width=600,
                    height=400,
                    scroll=ft.ScrollMode.AUTO,
                    tight=True
                )

                update_dialog = ft.AlertDialog(
                    title=ft.Text("发现新版本"),
                    content=content_column,
                    actions=[
                        ft.TextButton("前往下载", on_click=open_download_page),
                        ft.TextButton("稍后提醒", on_click=lambda e: self.page.pop_dialog()),
                    ],
                    actions_alignment=ft.MainAxisAlignment.END,
                )
                self.page.show_dialog(update_dialog)
        else:
            self._showMsg("当前已是最新版本")
    
    def run_check_sync(self):
        """
        同步版本的运行检查更新功能，用于在线程中调用异步方法
        """
        def run_loop():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(self.run_check())
            finally:
                loop.close()
        
        thread = threading.Thread(target=run_loop)
        thread.daemon = True
        thread.start()

    def get_github_mirror(self):
        """
        获取配置中的GitHub镜像地址
        """
        mirror = self.config_manager.get("github.mirror", "github")
        return mirror

    async def get_latest_release_version_from_raw(self):
        """
        通过GitHub RAW链接获取最新版本号
        
        Returns:
            str: 最新版本号，如果出错则返回None
        """
        mirror = self.get_github_mirror()
        
        # 构建RAW URL
        if mirror == "github":
            raw_url = "https://raw.githubusercontent.com/LingyeSoul/SillyTavernLauncher/refs/heads/main/src/version.py"
        else:
            # 使用镜像站
            raw_url = "https://gitee.com/lingyesoul/SillyTavernLauncher/raw/main/src/version.py"
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(raw_url, headers={'User-Agent': 'SillyTavernLauncher/1.0'}, timeout=aiohttp.ClientTimeout(total=10)) as response:
                    if response.status == 200:
                        content = await response.text()
                        # 解析内容提取版本号
                        for line in content.split('\n'):
                            if line.startswith('VERSION ='):
                                # 提取版本号值
                                version = line.split('=')[1].strip().strip("'\"")
                                return version
                    return None
                
        except aiohttp.ClientError as e:
            app_logger.error(f"网络错误: {e}")
            app_logger.error(f"网络错误: {e}")
            return None
        except Exception as e:
            print(f"获取版本信息时出错: {e}")
            return None

    async def get_latest_release_version(self):
        """
        通过GitHub API获取最新版本号
        
        Returns:
            str: 最新版本号，如果出错则返回None
        """
        # 首先尝试通过RAW方式获取
        version = await self.get_latest_release_version_from_raw()
        if version:
            return version
            
        # 如果RAW方式失败，回退到API方式
        mirror = self.get_github_mirror()
        
        # 构建API URL
        if mirror == "github":
            api_url = "https://api.github.com/repos/LingyeSoul/SillyTavernLauncher/releases/latest"
        else:
            # 使用镜像站
            api_url = f"https://{mirror}/https://api.github.com/repos/LingyeSoul/SillyTavernLauncher/releases/latest"
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(api_url, headers={'User-Agent': 'SillyTavernLauncher/1.0'}, timeout=aiohttp.ClientTimeout(total=10)) as response:
                    if response.status == 200:
                        data = await response.json()
                        
                        # 提取版本号
                        if 'tag_name' in data:
                            return data['tag_name']
                        elif 'name' in data:
                            return data['name']
                        else:
                            return None
                    else:
                        print(f"API请求失败，状态码: {response.status}")
                        return None
                
        except aiohttp.ClientError as e:
            app_logger.error(f"网络错误: {e}")
            return None
        except Exception as e:
            print(f"获取版本信息时出错: {e}")
            return None

    def is_beta_version(self, version_str):
        """
        检查版本是否为测试版
        
        Args:
            version_str (str): 版本字符串
            
        Returns:
            bool: 如果是测试版则返回True，否则返回False
        """
        # 检查是否包含"测试版"、"beta"、"Beta"、"BETA"等标识
        beta_patterns = [
            r'测试版',      # 中文"测试版"
            r'beta',       # 英文小写
            r'Beta',       # 英文首字母大写
            r'BETA',       # 英文全大写
            r'test',       # 测试版本
            r'Test',       # 测试版本
            r'TEST',       # 测试版本
            r'alpha',      # alpha版本
            r'Alpha',      # alpha版本
            r'ALPHA',      # alpha版本
            r'rc',         # release candidate
            r'RC',         # release candidate
            r'pre',        # preview
            r'Preview',    # preview
            r'dev',        # development
            r'Dev'         # development
        ]
        
        for pattern in beta_patterns:
            if re.search(pattern, version_str):
                return True
        return False

    def compare_versions(self, local_version, remote_version):
        """
        比较两个版本号
        
        Args:
            local_version (str): 本地版本号
            remote_version (str): 远程版本号
            
        Returns:
            int: 1表示本地版本更新，-1表示远程版本更新，0表示版本相同
        """
        # 如果远程版本是测试版，无论本地版本是什么，都不认为有更新
        if self.is_beta_version(remote_version):
            return 0  # 认为版本相同，不提示更新
        
        # 移除版本号中的前缀"v"
        local_clean = local_version.replace("v", "")
        remote_clean = remote_version.replace("v", "")
        
        # 使用正则表达式分离版本号和可能的后缀（如"测试版"或"测试版12"）
        # 匹配主要版本号（数字和点）以及可选的后缀部分
        local_match = re.match(r'^(\d+(?:\.\d+)*)\s*(.*)$', local_clean)
        remote_match = re.match(r'^(\d+(?:\.\d+)*)\s*(.*)$', remote_clean)
        
        if local_match:
            local_main = local_match.group(1)
            local_suffix = local_match.group(2)
        else:
            # 如果没有匹配到标准格式，将整个字符串作为主要版本号
            local_main = local_clean
            local_suffix = ""
            
        if remote_match:
            remote_main = remote_match.group(1)
            remote_suffix = remote_match.group(2)
        else:
            # 如果没有匹配到标准格式，将整个字符串作为主要版本号
            remote_main = remote_clean
            remote_suffix = ""
        
        # 如果主要版本号不同，按主要版本号比较
        if local_main != remote_main:
            # 分割版本号的各部分进行比较
            local_nums = [int(x) for x in local_main.split(".") if x.isdigit()]
            remote_nums = [int(x) for x in remote_main.split(".") if x.isdigit()]
            
            # 逐个比较版本号的每个部分
            for i in range(max(len(local_nums), len(remote_nums))):
                local_num = local_nums[i] if i < len(local_nums) else 0
                remote_num = remote_nums[i] if i < len(remote_nums) else 0
                
                if local_num > remote_num:
                    return 1
                elif local_num < remote_num:
                    return -1
        
        # 主要版本号相同的情况下，检查后缀
        local_has_suffix = len(local_suffix) > 0
        remote_has_suffix = len(remote_suffix) > 0
        
        # 检查后缀是否是测试版（这个检查现在应该不会执行，因为远程测试版已经被上面的逻辑处理了）
        local_is_beta = self.is_beta_version(local_suffix)
        remote_is_beta = self.is_beta_version(remote_suffix)
        
        # 如果远程版本不是测试版，但本地版本是测试版，则远程版本更新
        if local_is_beta and not remote_is_beta:
            return -1  # 远程版本更新
        
        # 如果本地有后缀而远程没有，则远程版本更新
        if local_has_suffix and not remote_has_suffix:
            return -1
        # 如果远程有后缀而本地没有，则本地版本更新
        elif not local_has_suffix and remote_has_suffix:
            return 1
        # 如果两者都有后缀，则比较后缀
        elif local_has_suffix and remote_has_suffix:
            # 如果都是测试版格式
            local_beta_match = re.search(r'测试版\s*(\d*)|beta\s*(\d*)|Beta\s*(\d*)', local_suffix, re.IGNORECASE)
            remote_beta_match = re.search(r'测试版\s*(\d*)|beta\s*(\d*)|Beta\s*(\d*)', remote_suffix, re.IGNORECASE)
            
            # 如果都是测试版格式
            if local_beta_match and remote_beta_match:
                # 提取数字部分
                local_beta_nums = [g for g in local_beta_match.groups() if g is not None]
                remote_beta_nums = [g for g in remote_beta_match.groups() if g is not None]
                
                local_beta_num = local_beta_nums[0] if local_beta_nums else ""
                remote_beta_num = remote_beta_nums[0] if remote_beta_nums else ""
                
                # 如果都有测试版号，则比较测试版号
                if local_beta_num and remote_beta_num:
                    if int(local_beta_num) > int(remote_beta_num):
                        return 1
                    elif int(local_beta_num) < int(remote_beta_num):
                        return -1
                    else:
                        return 0
                # 如果一个有测试版号，另一个没有，则有测试版号的更新
                elif local_beta_num and not remote_beta_num:
                    return 1
                elif not local_beta_num and remote_beta_num:
                    return -1
                # 如果都没有测试版号，则相同
                else:
                    return 0
            # 如果后缀不同，则简单比较字符串
            else:
                if local_suffix < remote_suffix:
                    return -1
                elif local_suffix > remote_suffix:
                    return 1
                else:
                    return 0
        # 如果两者都没有后缀，则版本相同
        else:
            return 0

    async def check_for_updates(self):
        """
        检查是否有更新版本
        
        Returns:
            dict: 包含检查结果的字典
        """
        latest_version = await self.get_latest_release_version_from_raw()
        
        if latest_version is None:
            # 尝试使用API方式获取
            latest_version = await self.get_latest_release_version()
            
        if latest_version is None:
            return {
                "has_error": True,
                "error_message": "无法获取最新版本信息，请检查网络连接或稍后重试",
                "current_version": self.current_version,
                "latest_version": None,
                "has_update": False
            }
        
        try:
            comparison = self.compare_versions(self.current_version, latest_version)
        except Exception as e:
            return {
                "has_error": True,
                "error_message": f"版本比较时出错: {str(e)}",
                "current_version": self.current_version,
                "latest_version": latest_version,
                "has_update": False
            }
        
        return {
            "has_error": False,
            "error_message": None,
            "current_version": self.current_version,
            "latest_version": latest_version,
            "has_update": comparison < 0
        }