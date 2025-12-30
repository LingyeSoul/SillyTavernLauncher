"""
SillyTavern版本管理器
负责获取版本列表和当前版本信息
"""
import json
import os
import aiohttp
import asyncio
from datetime import datetime
from config import ConfigManager


class STVersionManager:
    """SillyTavern版本管理器"""

    def __init__(self):
        self.config_manager = ConfigManager()
        self.st_dir = os.path.join(os.getcwd(), "SillyTavern")

        # STVersions.json的URL地址
        self.github_url = "https://raw.githubusercontent.com/LingyeSoul/SillyTavern/refs/heads/release/STVersions.json"
        self.gitee_url = "https://gitee.com/lingyesoul/SillyTavern/raw/release/STVersions.json"

    def get_versions_json_url(self):
        """
        根据配置返回正确的STVersions.json URL

        Returns:
            str: URL地址
        """
        mirror = self.config_manager.get("github.mirror", "github")

        if mirror == "github":
            return self.github_url
        else:
            return self.gitee_url

    async def fetch_st_versions(self):
        """
        从远程获取STVersions.json并解析

        Returns:
            dict: {
                'success': True/False,
                'versions': {...},
                'latest': '1.15.0',
                'error': error_message
            }
        """
        url = self.get_versions_json_url()

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    headers={'User-Agent': 'SillyTavernLauncher/1.0'},
                    timeout=aiohttp.ClientTimeout(total=15)
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        return {
                            'success': True,
                            'versions': data.get('versions', {}),
                            'latest': data.get('latest', ''),
                            'error': None
                        }
                    else:
                        return {
                            'success': False,
                            'versions': {},
                            'latest': '',
                            'error': f'HTTP {response.status}'
                        }
        except asyncio.TimeoutError:
            return {
                'success': False,
                'versions': {},
                'latest': '',
                'error': '网络请求超时，请检查网络连接'
            }
        except aiohttp.ClientError as e:
            return {
                'success': False,
                'versions': {},
                'latest': '',
                'error': f'网络错误: {str(e)}'
            }
        except json.JSONDecodeError:
            return {
                'success': False,
                'versions': {},
                'latest': '',
                'error': '版本列表格式错误，请联系开发者'
            }
        except Exception as e:
            return {
                'success': False,
                'versions': {},
                'latest': '',
                'error': f'未知错误: {str(e)}'
            }

    def get_current_version(self):
        """
        从SillyTavern/package.json获取当前版本号

        Returns:
            dict: {
                'success': True/False,
                'version': '1.13.5',
                'error': error_message
            }
        """
        try:
            package_json_path = os.path.join(self.st_dir, 'package.json')

            if not os.path.exists(package_json_path):
                return {
                    'success': False,
                    'version': 'unknown',
                    'error': 'SillyTavern未安装或package.json不存在'
                }

            with open(package_json_path, 'r', encoding='utf-8') as f:
                package_data = json.load(f)
                version = package_data.get('version', 'unknown')

                return {
                    'success': True,
                    'version': version,
                    'error': None
                }

        except FileNotFoundError:
            return {
                'success': False,
                'version': 'unknown',
                'error': 'package.json文件不存在，请先安装SillyTavern'
            }
        except json.JSONDecodeError:
            return {
                'success': False,
                'version': 'unknown',
                'error': 'package.json格式错误'
            }
        except PermissionError:
            return {
                'success': False,
                'version': 'unknown',
                'error': '没有读取权限'
            }
        except Exception as e:
            return {
                'success': False,
                'version': 'unknown',
                'error': f'读取失败: {str(e)}'
            }

    def format_version_date(self, date_str):
        """
        格式化版本日期字符串

        Args:
            date_str (str): ISO格式日期字符串

        Returns:
            str: 格式化后的日期
        """
        try:
            # 处理ISO格式日期
            date_obj = datetime.fromisoformat(date_str.replace('+02:00', '').replace('+03:00', '').replace('Z', ''))
            return date_obj.strftime('%Y-%m-%d %H:%M')
        except:
            # 如果解析失败，返回原字符串
            return date_str

    def run_fetch_async(self):
        """
        同步包装器，用于在线程中运行异步获取版本列表

        Returns:
            dict: fetch_st_versions的返回值
        """
        def run_loop():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                return loop.run_until_complete(self.fetch_st_versions())
            finally:
                loop.close()

        import threading
        result = {}
        def worker():
            nonlocal result
            result = run_loop()

        thread = threading.Thread(target=worker)
        thread.daemon = True
        thread.start()
        thread.join(timeout=20)

        if thread.is_alive():
            return {
                'success': False,
                'versions': {},
                'latest': '',
                'error': '获取版本列表超时'
            }

        return result
