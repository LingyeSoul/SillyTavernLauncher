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
        import re
        
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
        
        # 如果本地有后缀而远程没有，则远程版本更新
        if local_has_suffix and not remote_has_suffix:
            return -1
        # 如果远程有后缀而本地没有，则本地版本更新
        elif not local_has_suffix and remote_has_suffix:
            return 1
        # 如果两者都有后缀，则比较后缀
        elif local_has_suffix and remote_has_suffix:
            # 如果都是测试版，比较测试版号
            local_beta_match = re.match(r'^测试版\s*(\d*)$', local_suffix)
            remote_beta_match = re.match(r'^测试版\s*(\d*)$', remote_suffix)
            
            # 如果都是测试版格式
            if local_beta_match and remote_beta_match:
                local_beta_num = local_beta_match.group(1)
                remote_beta_num = remote_beta_match.group(1)
                
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