"""
SillyTavern版本管理器
负责获取版本列表和当前版本信息
"""
import json
import os
from datetime import datetime
from config.config_manager import ConfigManager


class STVersionManager:
    """SillyTavern版本管理器"""

    def __init__(self):
        self.config_manager = ConfigManager()
        self.st_dir = os.path.join(os.getcwd(), "SillyTavern")

    def get_versions_json_url(self):
        """
        [已废弃] 不再从远程获取版本列表

        Returns:
            str: 返回空字符串
        """
        return ""

    def fetch_st_versions(self):
        """
        从本地Git仓库获取版本列表

        Returns:
            dict: {
                'success': True/False,
                'versions': {...},
                'latest': '1.15.0',
                'error': error_message
            }
        """
        from core.git_utils import get_st_tags

        try:
            success, tags_data, message = get_st_tags(self.st_dir)

            if success:
                return {
                    'success': True,
                    'versions': tags_data.get('versions', {}),
                    'latest': tags_data.get('latest', ''),
                    'error': None
                }
            else:
                return {
                    'success': False,
                    'versions': {},
                    'latest': '',
                    'error': message
                }
        except Exception as e:
            return {
                'success': False,
                'versions': {},
                'latest': '',
                'error': f'获取版本列表失败: {str(e)}'
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
        获取版本列表（同步调用）

        Returns:
            dict: fetch_st_versions的返回值
        """
        return self.fetch_st_versions()
