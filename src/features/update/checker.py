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
from version import VERSION, RELEASES_VERSION
import threading
import re

class VersionChecker:
    def __init__(self, page):
        self.config_manager = ConfigManager()
        # 使用本地 VERSION 作为当前版本，与远程 RELEASES_VERSION 进行比较
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
        changelog_url = "https://sillytavern.lingyesoul.top/changelog"

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(changelog_url,
                                       headers={'User-Agent': 'SillyTavernLauncher/1.0'},
                                       timeout=aiohttp.ClientTimeout(total=15)) as response:
                    if response.status == 200:
                        html_content = await response.text()

                        # 从 VitePress 渲染的 HTML 中提取内容并转换为 Markdown
                        # 查找主内容区域 (vp-doc class)
                        vp_doc_start = html_content.find('class="vp-doc')
                        if vp_doc_start != -1:
                            app_logger.info("找到 vp-doc 容器")
                            # 回溯到 <div 标签开始
                            div_start = html_content.rfind('<div', 0, vp_doc_start)
                            # 找到 </main> 作为结束位置
                            main_end = html_content.find('</main>', div_start)
                            if main_end != -1:
                                app_logger.info("找到 </main> 标签")
                                # 提取 vp-doc 的内容（跳过开始的 <div> 标签）
                                first_gt = html_content.find('>', div_start) + 1
                                extracted_html = html_content[first_gt:main_end]
                                app_logger.info(f"提取的 HTML 长度: {len(extracted_html)}")
                                # 将 HTML 转换为 Markdown
                                markdown_text = self._html_to_markdown(extracted_html)
                                app_logger.info(f"转换后的 Markdown 长度: {len(markdown_text) if markdown_text else 0}")
                                if markdown_text:
                                    app_logger.info(f"Markdown 前100字符: {markdown_text[:100]}")
                                    return markdown_text
                            else:
                                app_logger.warning("未找到 </main> 标签")
                        else:
                            app_logger.warning("未找到 vp-doc 容器")

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

    def _html_to_markdown(self, html_content):
        """
        将 VitePress 渲染的 HTML 转换为 Markdown

        Args:
            html_content (str): HTML 内容

        Returns:
            str: Markdown 格式的内容
        """
        import html as html_module

        # HTML 解码
        html_content = html_module.unescape(html_content)

        # 移除所有 script 和 style 标签
        html_content = re.sub(r'<script[^>]*>.*?</script>', '', html_content, flags=re.DOTALL | re.IGNORECASE)
        html_content = re.sub(r'<style[^>]*>.*?</style>', '', html_content, flags=re.DOTALL | re.IGNORECASE)

        # 移除 header-anchor 链接
        html_content = re.sub(r'<a class="header-anchor"[^>]*>.*?</a>', '', html_content, flags=re.DOTALL)

        # 在每个开始标签前添加换行（除了闭合标签）
        html_content = re.sub(r'<(?!/)([a-z0-9]+)', r'\n<\1', html_content, flags=re.IGNORECASE)

        # 移除所有闭合标签，但保留内容
        html_content = re.sub(r'</[a-z0-9]+>', '', html_content, flags=re.IGNORECASE)

        markdown_lines = []
        lines = html_content.split('\n')
        i = 0

        while i < len(lines):
            line = lines[i].strip()
            if not line:
                i += 1
                continue

            # 处理 h1 标题
            if line.startswith('<h1'):
                text = re.sub(r'<h1[^>]*>', '', line)
                text = re.sub(r'<[^>]+>', '', text).strip()
                if text:
                    markdown_lines.append(f'# {text}')
                i += 1

            # 处理 h2 标题（版本标题）
            elif line.startswith('<h2'):
                text = re.sub(r'<h2[^>]*>', '', line)
                text = re.sub(r'<[^>]+>', '', text).strip()
                if text:
                    markdown_lines.append(f'## {text}')
                i += 1

            # 处理 h3 标题（章节标题）
            elif line.startswith('<h3'):
                text = re.sub(r'<h3[^>]*>', '', line)
                text = re.sub(r'<[^>]+>', '', text).strip()
                if text:
                    markdown_lines.append(f'### {text}')
                i += 1

            # 处理 <p> 标签
            elif line.startswith('<p>'):
                text = re.sub(r'<[^>]+>', '', line).strip()
                if text:
                    # 检查是否包含 strong 标签
                    if '<strong>' in line or '<b>' in line:
                        # 提取 strong 内容
                        strong_match = re.search(r'<(strong|b)>(.*?)</\1>', line)
                        if strong_match:
                            bold_text = strong_match.group(2).strip()
                            markdown_lines.append(f'- **{bold_text}**')
                        else:
                            markdown_lines.append(text)
                    else:
                        markdown_lines.append(text)
                i += 1

            # 处理列表项（收集后续的 code 标签）
            elif line.startswith('<li>'):
                # 提取当前行的文本
                text = re.sub(r'<li>', '', line).strip()
                list_parts = [text]

                # 查找后续的 <code> 标签（属于同一个列表项）
                j = i + 1
                while j < len(lines):
                    next_line = lines[j].strip()
                    if next_line.startswith('<code>'):
                        # 提取 code 内容
                        code_match = re.search(r'<code>(.*?)</code>', next_line)
                        if code_match:
                            code_text = code_match.group(1)
                            list_parts.append(code_text)
                        j += 1
                    elif next_line.startswith('<') and not next_line.startswith('<code'):
                        # 遇到其他标签，停止收集
                        break
                    else:
                        # 普通文本，也添加到列表项
                        if next_line:
                            list_parts.append(next_line)
                        j += 1

                # 合并所有内容为一行，用空格分隔
                combined_text = ' - '.join(list_parts)
                markdown_lines.append(f'- {combined_text}')
                i = j  # 跳到已处理行的下一行

            # 处理 hr 分隔线
            elif line.startswith('<hr'):
                markdown_lines.append('---')
                i += 1

            # 处理 <ul> 和 <ol> 标签（跳过）
            elif line.startswith('<ul>') or line.startswith('<ol>') or line.startswith('</ul>') or line.startswith('</ol>'):
                i += 1

            # 处理普通文本行
            elif not line.startswith('<'):
                text = re.sub(r'<[^>]+>', '', line).strip()
                if text:
                    markdown_lines.append(text)
                i += 1

            # 其他情况，跳过
            else:
                i += 1

        return '\n\n'.join(markdown_lines)

    def _parse_changelog_to_components(self, markdown_text, local_version, remote_version):
        """
        将 Markdown 更新日志解析为 Flet UI 组件

        只显示本地版本和远程版本之间的版本日志

        Args:
            markdown_text (str): Markdown 格式的更新日志
            local_version (str): 本地版本号
            remote_version (str): 远程版本号

        Returns:
            list: Flet UI 组件列表
        """
        if not markdown_text:
            return [ft.Text("暂无更新日志")]

        # 版本比较辅助函数
        def compare_version_nums(v1, v2):
            """比较两个版本号，返回 1(v1>v2), -1(v1<v2), 0(相等)"""
            v1_parts = [int(x) for x in v1.replace('v', '').split('.') if x.isdigit()]
            v2_parts = [int(x) for x in v2.replace('v', '').split('.') if x.isdigit()]

            for i in range(max(len(v1_parts), len(v2_parts))):
                v1_num = v1_parts[i] if i < len(v1_parts) else 0
                v2_num = v2_parts[i] if i < len(v2_parts) else 0

                if v1_num > v2_num:
                    return 1
                elif v1_num < v2_num:
                    return -1
            return 0

        # 解析本地和远程版本号
        local_clean = local_version.replace('v', '').strip()
        remote_clean = remote_version.replace('v', '').strip()

        app_logger.info(f"解析更新日志 - 本地版本: {local_clean}, 远程版本: {remote_clean}")

        # 第一步：解析所有版本的更新日志
        all_versions = []
        lines = markdown_text.split('\n')
        current_version = None
        current_section = None
        current_items = []

        i = 0
        while i < len(lines):
            line = lines[i].strip()

            # 检测版本标题（## vX.X.X (YYYY-MM-DD)）
            version_match = re.match(r'^##\s+v?(\d+\.\d+\.\d+)', line)
            if version_match:
                version_num = version_match.group(1)
                app_logger.info(f"解析到版本: {version_num}")

                # 保存上一个版本的内容
                if current_version and current_items:
                    all_versions.append({
                        'version': current_version,
                        'section': current_section,
                        'items': current_items.copy()
                    })

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
            elif line.startswith('-') or line.startswith('*'):
                # 跳过分隔线（只由 -、* 或 _ 组成的行）
                if re.match(r'^[\-\*_]{3,}\s*$', line):
                    pass
                else:
                    # 移除 - 或 * 前缀
                    item_text = re.sub(r'^[\-\*]\s+', '', line).strip()
                    # 过滤无意义的列表项（空、只有符号、或只有连接符）
                    if item_text and not re.match(r'^[\-\s]+$', item_text):
                        current_items.append(item_text)
            # 处理数字开头的列表项（但不去除数字，因为可能是内容的一部分）
            elif re.match(r'^\d+\.', line):
                item_text = line.strip()
                # 过滤无意义的列表项
                if item_text and not re.match(r'^[\d\.\s]+$', item_text):
                    current_items.append(item_text)

            i += 1

        # 添加最后一个版本
        if current_version and current_items:
            all_versions.append({
                'version': current_version,
                'section': current_section,
                'items': current_items.copy()
            })

        app_logger.info(f"共解析到 {len(all_versions)} 个版本")

        # 第二步：根据本地和远程版本进行过滤
        filtered_versions = []
        for ver_data in all_versions:
            # 从版本字符串中提取版本号
            version_match = re.search(r'(\d+\.\d+\.\d+)', ver_data['version'])
            if version_match:
                version_num = version_match.group(1)

                # 检查版本是否在本地和远程之间
                # 版本应该大于本地版本，且小于等于远程版本
                should_include = (
                    compare_version_nums(version_num, local_clean) > 0 and
                    compare_version_nums(version_num, remote_clean) <= 0
                )

                app_logger.info(f"版本 {version_num}: 是否包含 = {should_include} (>{local_clean} and <={remote_clean})")

                if should_include:
                    filtered_versions.append(ver_data)

        app_logger.info(f"过滤后剩余 {len(filtered_versions)} 个版本")

        # 第三步：将过滤后的版本转换为 UI 组件
        components = []
        for ver_data in filtered_versions:
            components.append(self._create_version_block(
                ver_data['version'],
                ver_data['section'],
                ver_data['items']
            ))

        app_logger.info(f"最终生成 {len(components)} 个版本块")

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
            ft.Text(version_num, size=18, weight=ft.FontWeight.BOLD),
        ]

        if date_str:
            content_controls.append(ft.Text(f"发布日期: {date_str}", size=12))

        content_controls.append(ft.Divider(height=10, color=ft.Colors.GREY_300))

        # 添加章节标题
        if section:
            # 保留原始 section（包含 emoji），只用于颜色判断
            content_controls.append(
                ft.Text(section, size=14, weight=ft.FontWeight.W_500, color=section_color)
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
                    await UrlLauncher().launch_url("https://sillytavern.lingyesoul.top/update")

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
                # 正式版，显示简单的更新对话框
                async def open_download_page(e):
                    await UrlLauncher().launch_url("https://sillytavern.lingyesoul.top/update")

                async def open_changelog(e):
                    await UrlLauncher().launch_url("https://sillytavern.lingyesoul.top/changelog")

                update_dialog = ft.AlertDialog(
                    title=ft.Text("发现新版本"),
                    content=ft.Column([
                        ft.Text(f"当前版本: {result['current_version']}", size=14),
                        ft.Text(f"最新版本: {result['latest_version']}", size=14),
                        ft.Divider(height=20),
                        ft.Text("建议更新到最新版本以获得更好的体验和新功能。", size=14),
                    ], width=400, height=150),
                    actions=[
                        ft.TextButton("查看更新日志", on_click=open_changelog),
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
        通过GitHub RAW链接获取远程的RELEASES_VERSION（正式发布版本号）

        Returns:
            str: 远程RELEASES_VERSION版本号，如果出错则返回None
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
                        # 解析内容提取远程的 RELEASES_VERSION（正式发布版本号）
                        for line in content.split('\n'):
                            if line.startswith('RELEASES_VERSION ='):
                                # 提取版本号值
                                version = line.split('=')[1].strip().strip("'\"")
                                return version
                    return None

        except aiohttp.ClientError as e:
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
                "current_version": VERSION,  # 显示当前运行的实际版本
                "latest_version": None,
                "has_update": False
            }

        try:
            comparison = self.compare_versions(self.current_version, latest_version)
        except Exception as e:
            return {
                "has_error": True,
                "error_message": f"版本比较时出错: {str(e)}",
                "current_version": VERSION,  # 显示当前运行的实际版本
                "latest_version": latest_version,
                "has_update": False
            }

        return {
            "has_error": False,
            "error_message": None,
            "current_version": VERSION,  # 显示当前运行的实际版本
            "latest_version": latest_version,
            "has_update": comparison < 0
        }