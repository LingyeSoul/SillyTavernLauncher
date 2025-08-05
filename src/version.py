import json
import urllib.request
import urllib.error
from config import ConfigManager
import flet as ft
import ssl


class VersionChecker:
    def __init__(self,ver,page):
        self.config_manager = ConfigManager()
        self.current_version = ver
        self.page = page
        # 禁用SSL证书验证（仅在需要时使用）
        self.context = ssl.create_default_context()
        self.context.check_hostname = False
        self.context.verify_mode = ssl.CERT_NONE
    def _showMsg(self,v):
        self.page.open(ft.SnackBar(ft.Text(v),show_close_icon=True,duration=3000))

    def run_check(self):
        def show_update_dialog(self):
            update_dialog = ft.AlertDialog(
            title=ft.Text("发现新版本"),
            content=ft.Column([
                    ft.Text(f"当前版本: {result['current_version']}", size=14),
                        ft.Text(f"最新版本: {result['latest_version']}", size=14),
                        ft.Text("建议更新到最新版本以获得更好的体验和新功能。", size=14),
                    ], width=400, height=120),
                    actions=[
                        ft.TextButton("前往下载", on_click=lambda e: self.page.launch_url("https://sillytavern.lingyesoul.top/update.html")),
                        ft.TextButton("稍后提醒", on_click=lambda e: self.page.close(update_dialog)),
                        ],
                        actions_alignment=ft.MainAxisAlignment.END,
                    )
            self.page.open(update_dialog)
        result = self.check_for_updates()
        if result["has_error"]:
            self._showMsg(f"检查更新失败: {result['error_message']}")
        elif result["has_update"]:
            show_update_dialog(self)
        else:
            self._showMsg("当前已是最新版本")

    

    def get_github_mirror(self):
        """
        获取配置中的GitHub镜像地址
        """
        mirror = self.config_manager.get("github.mirror", "github")
        return mirror

    def get_latest_release_version(self):
        """
        通过GitHub API获取最新版本号
        
        Returns:
            str: 最新版本号，如果出错则返回None
        """
        mirror = self.get_github_mirror()
        
        # 构建API URL
        if mirror == "github":
            api_url = "https://api.github.com/repos/LingyeSoul/SillyTavernLauncher/releases/latest"
        else:
            # 使用镜像站
            api_url = f"https://{mirror}/https://api.github.com/repos/LingyeSoul/SillyTavernLauncher/releases/latest"
        
        try:
            # 创建请求
            request = urllib.request.Request(
                api_url,
                headers={
                    'User-Agent': 'SillyTavernLauncher/1.0'
                }
            )
            
            # 发送请求
            response = urllib.request.urlopen(request, context=self.context, timeout=10)
            data = json.loads(response.read().decode('utf-8'))
            
            # 提取版本号
            if 'tag_name' in data:
                return data['tag_name']
            elif 'name' in data:
                return data['name']
            else:
                return None
                
        except urllib.error.URLError as e:
            print(f"网络错误: {e}")
            return None
        except json.JSONDecodeError as e:
            print(f"JSON解析错误: {e}")
            return None
        except Exception as e:
            print(f"获取版本信息时出错: {e}")
            return None

    def compare_versions(self, local_version, remote_version):
        """
        比较两个版本号
        
        Args:
            local_version (str): 本地版本号
            remote_version (str): 远程版本号
            
        Returns:
            int: 1表示本地版本更新，-1表示远程版本更新，0表示版本相同
        """
        # 简单的版本比较实现
        # 移除版本号中的"测试版"等中文字符
        local_clean = local_version.replace("测试版", "").replace("测试版", "")
        remote_clean = remote_version.replace("测试版", "").replace("测试版", "")
        local_clean = local_version.replace("v", "").replace("v", "")
        remote_clean = remote_version.replace("v", "").replace("v", "")
        
        # 如果版本号相同
        if local_clean == remote_clean:
            if local_version != remote_version:
                return -1
            return 0
        elif local_clean > remote_clean:
            return 1
        else:
            return -1

    def check_for_updates(self):
        """
        检查是否有更新版本
        
        Returns:
            dict: 包含检查结果的字典
        """
        latest_version = self.get_latest_release_version()
        
        if latest_version is None:
            return {
                "has_error": True,
                "error_message": "无法获取最新版本信息",
                "current_version": self.current_version,
                "latest_version": None,
                "has_update": False
            }
        
        comparison = self.compare_versions(self.current_version, latest_version)
        
        return {
            "has_error": False,
            "error_message": None,
            "current_version": self.current_version,
            "latest_version": latest_version,
            "has_update": comparison < 0
        }