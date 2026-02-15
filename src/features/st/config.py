import os
from ruamel.yaml import YAML
from utils.logger import app_logger
from core.network import get_network_manager


class stcfg:
    def __init__(self):
        self.base_dir = os.path.join(os.getcwd(), "SillyTavern")
        self.config_path = os.path.join(self.base_dir, "config.yaml")
        self.whitelist_path = os.path.join(self.base_dir, "whitelist.txt")
        self.listen = False
        self.port = 8000
        self.proxy_enabled = False
        self.proxy_url = ""
        self.host_whitelist_enabled = False
        self.host_whitelist_scan = True
        self.host_whitelist_hosts = ["localhost", "127.0.0.1", "[::1]"]

        # 初始化YAML处理对象
        self.yaml = YAML()
        self.yaml.preserve_quotes = True

        self.config_data = {}
        self.load_config()

    def load_config(self):
        try:
            with open(self.config_path, "r", encoding="utf-8") as file:
                self.config_data = self.yaml.load(file) or {}

                # 保留原始配置内容
                self.listen = self.config_data.get("listen", False)
                self.port = self.config_data.get("port", 8000)
                # 加载requestProxy配置
                request_proxy = self.config_data.get("requestProxy", {})
                self.proxy_enabled = request_proxy.get("enabled", False)
                self.proxy_url = request_proxy.get("url", "")
                # 加载hostWhitelist配置（防止DNS重绑定攻击）
                host_whitelist = self.config_data.get("hostWhitelist", {})
                self.host_whitelist_enabled = host_whitelist.get("enabled", False)
                self.host_whitelist_scan = host_whitelist.get("scan", True)
                self.host_whitelist_hosts = host_whitelist.get(
                    "hosts", ["localhost", "127.0.0.1", "[::1]"]
                )
        except Exception as e:
            app_logger.error(f"配置加载错误: {str(e)}")
            self.config_data = {"listen": self.listen, "port": self.port}

    def save_config(self):
        try:
            # 确保目标目录 exist
            os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
            # 仅更新需要修改的字段
            self.config_data["listen"] = self.listen
            self.config_data["port"] = self.port
            # 保存requestProxy配置
            if "requestProxy" not in self.config_data:
                self.config_data["requestProxy"] = {}
            self.config_data["requestProxy"]["enabled"] = self.proxy_enabled
            self.config_data["requestProxy"]["url"] = self.proxy_url
            # 保存hostWhitelist配置（防止DNS重绑定攻击）
            if "hostWhitelist" not in self.config_data:
                self.config_data["hostWhitelist"] = {}
            self.config_data["hostWhitelist"]["enabled"] = self.host_whitelist_enabled
            self.config_data["hostWhitelist"]["scan"] = self.host_whitelist_scan
            self.config_data["hostWhitelist"]["hosts"] = self.host_whitelist_hosts

            with open(self.config_path, "w", encoding="utf-8") as file:
                self.yaml.dump(self.config_data, file)

        except Exception as e:
            app_logger.error(f"配置保存失败: {str(e)}")

    def _get_subnet_from_ip(self, ip: str) -> str:
        """
        从IP地址提取网段

        Args:
            ip: IP地址，如 "192.168.1.100"

        Returns:
            网段字符串，如 "192.168.1.*"，如果提取失败则返回 None
        """
        try:
            parts = ip.split(".")
            if len(parts) == 4:
                return f"{parts[0]}.{parts[1]}.{parts[2]}.*"
            return None
        except Exception:
            return None

    def _check_and_update_whitelist_subnet(self):
        """
        检查并更新白名单中的网段
        如果检测到白名单中的网段与当前设备网络不匹配，则进行更新
        """
        if not os.path.exists(self.whitelist_path):
            return False

        try:
            # 读取当前白名单
            with open(self.whitelist_path, "r", encoding="utf-8") as f:
                current_whitelist = f.read()
        except Exception as e:
            app_logger.error(f"读取白名单文件失败: {str(e)}")
            return False

        # 获取当前设备的IP地址
        local_ip = get_network_manager().get_local_ip()
        if not local_ip:
            app_logger.warning("无法获取本地IP，跳过白名单网段检查")
            return False

        # 提取当前设备的网段
        current_subnet = self._get_subnet_from_ip(local_ip)
        if not current_subnet:
            app_logger.warning(f"无法从IP {local_ip} 提取网段")
            return False

        # 缓存 IP 部分，避免重复计算
        ip_parts = local_ip.split(".")
        # 验证IP格式,确保至少有4个部分
        if len(ip_parts) < 4:
            app_logger.warning(
                f"IP格式无效,期望4个部分但得到{len(ip_parts)}个: {local_ip}"
            )
            return False
        broader_subnet = f"{ip_parts[0]}.{ip_parts[1]}.*.*"

        # 检查白名单中是否已包含正确的网段
        subnet_exists = False
        whitelist_lines = []
        for line in current_whitelist.split("\n"):
            line = line.strip()
            if not line:
                continue
            whitelist_lines.append(line)
            # 检查是否已包含当前网段（支持 192.168.*.* 和 192.168.1.* 格式）
            if line == current_subnet or line == broader_subnet:
                subnet_exists = True

        # 如果网段已存在，无需更新
        if subnet_exists:
            return False

        # 构建新的白名单内容
        # 只移除与当前网段冲突的旧通配符网段，保留其他用户配置
        new_whitelist_lines = []
        for line in whitelist_lines:
            # 保留 127.0.0.1
            if line == "127.0.0.1":
                new_whitelist_lines.append(line)
            # 保留具体IP地址（不含通配符）
            elif "*" not in line and "." in line:
                new_whitelist_lines.append(line)
            # 保留不冲突的通配符网段（如 10.*.*.*，如果当前是 192.168.1.*）
            elif "*" in line:
                line_prefix = line.split(".")[0] if "." in line else ""
                # 验证第一部分是否为有效数字
                if line_prefix and line_prefix.isdigit() and line_prefix != ip_parts[0]:
                    # 第一段不同，不冲突
                    new_whitelist_lines.append(line)

        # 添加当前网段和本地回环地址
        if current_subnet not in new_whitelist_lines:
            new_whitelist_lines.insert(0, current_subnet)
        if "127.0.0.1" not in new_whitelist_lines:
            new_whitelist_lines.append("127.0.0.1")

        new_whitelist = "\n".join(new_whitelist_lines) + "\n"

        try:
            # 确保目标目录存在
            os.makedirs(os.path.dirname(self.whitelist_path), exist_ok=True)
            with open(self.whitelist_path, "w", encoding="utf-8") as f:
                f.write(new_whitelist)
            app_logger.info(f"白名单网段已更新: {current_subnet} (本地IP: {local_ip})")
            return True
        except Exception as e:
            app_logger.error(f"白名单更新失败: {str(e)}")
            return False

    def create_whitelist(self):
        """
        创建或更新白名单文件
        如果白名单不存在，则创建并使用当前设备的网段
        如果白名单存在但网段不匹配，则自动更新

        Returns:
            bool: 操作是否成功
        """
        # 先尝试检查并更新现有白名单
        if os.path.exists(self.whitelist_path):
            return self._check_and_update_whitelist_subnet()

        # 白名单不存在，创建新的
        try:
            # 获取当前设备的IP地址
            local_ip = get_network_manager().get_local_ip()

            # 确保目标目录存在
            os.makedirs(os.path.dirname(self.whitelist_path), exist_ok=True)

            with open(self.whitelist_path, "w", encoding="utf-8") as f:
                if local_ip:
                    # 使用实际网段
                    subnet = self._get_subnet_from_ip(local_ip)
                    if subnet:
                        f.write(f"{subnet}\n127.0.0.1\n")
                        app_logger.info(
                            f"白名单文件已创建，使用网段: {subnet} (本地IP: {local_ip})"
                        )
                    else:
                        # 无法提取网段，使用默认值
                        f.write("192.168.*.*\n127.0.0.1\n")
                        app_logger.warning(
                            f"无法提取网段，使用默认值 (本地IP: {local_ip})"
                        )
                else:
                    # 无法获取本地IP，使用默认值
                    f.write("192.168.*.*\n127.0.0.1\n")
                    app_logger.warning("无法获取本地IP，白名单使用默认值")
            return True
        except Exception as e:
            app_logger.error(f"白名单文件创建失败: {str(e)}")
            return False
