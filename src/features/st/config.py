import os
from typing import Optional
from ruamel.yaml import YAML
from utils.logger import app_logger
from core.network import get_network_manager


class stcfg:
    def __init__(self):
        self.base_dir = os.path.join(os.getcwd(), "SillyTavern")
        self.config_path = os.path.join(self.base_dir, "config.yaml")
        self.whitelist_txt_path = os.path.join(self.base_dir, "whitelist.txt")
        self.listen = False
        self.port = 8000
        self.proxy_enabled = False
        self.proxy_url = ""
        self.host_whitelist_enabled = False
        self.host_whitelist_scan = True
        self.host_whitelist_hosts = ["localhost", "127.0.0.1", "[::1]"]

        self.whitelist_mode = True
        self.enable_forwarded_whitelist = True
        self.whitelist_ips = ["::1", "127.0.0.1"]
        self.unified_whitelist = False

        self.yaml = YAML()
        self.yaml.preserve_quotes = True

        self.config_data = {}
        self.load_config()

    def load_config(self):
        try:
            with open(self.config_path, "r", encoding="utf-8") as file:
                self.config_data = self.yaml.load(file) or {}

                self.listen = self.config_data.get("listen", False)
                self.port = self.config_data.get("port", 8000)
                request_proxy = self.config_data.get("requestProxy", {})
                self.proxy_enabled = request_proxy.get("enabled", False)
                self.proxy_url = request_proxy.get("url", "")
                host_whitelist = self.config_data.get("hostWhitelist", {})
                self.host_whitelist_enabled = host_whitelist.get("enabled", False)
                self.host_whitelist_scan = host_whitelist.get("scan", True)
                self.host_whitelist_hosts = host_whitelist.get(
                    "hosts", ["localhost", "127.0.0.1", "[::1]"]
                )
                self.whitelist_mode = self.config_data.get("whitelistMode", True)
                self.enable_forwarded_whitelist = self.config_data.get(
                    "enableForwardedWhitelist", True
                )
                self.whitelist_ips = self.config_data.get(
                    "whitelist", ["::1", "127.0.0.1"]
                )
                self.unified_whitelist = self.config_data.get("unifiedWhitelist", False)

            self._migrate_whitelist_from_txt()

        except Exception as e:
            app_logger.error(f"配置加载错误: {str(e)}")
            self.config_data = {"listen": self.listen, "port": self.port}

    def save_config(self):
        try:
            os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
            self.config_data["listen"] = self.listen
            self.config_data["port"] = self.port
            if "requestProxy" not in self.config_data:
                self.config_data["requestProxy"] = {}
            self.config_data["requestProxy"]["enabled"] = self.proxy_enabled
            self.config_data["requestProxy"]["url"] = self.proxy_url
            if "hostWhitelist" not in self.config_data:
                self.config_data["hostWhitelist"] = {}
            self.config_data["hostWhitelist"]["enabled"] = self.host_whitelist_enabled
            self.config_data["hostWhitelist"]["scan"] = self.host_whitelist_scan
            self.config_data["hostWhitelist"]["hosts"] = self.host_whitelist_hosts
            self.config_data["whitelistMode"] = self.whitelist_mode
            self.config_data["enableForwardedWhitelist"] = (
                self.enable_forwarded_whitelist
            )
            self.config_data["whitelist"] = self.whitelist_ips
            self.config_data["unifiedWhitelist"] = self.unified_whitelist

            with open(self.config_path, "w", encoding="utf-8") as file:
                self.yaml.dump(self.config_data, file)

        except Exception as e:
            app_logger.error(f"配置保存失败: {str(e)}")

    def _get_subnet_from_ip(self, ip: str) -> Optional[str]:
        try:
            if ":" in ip:
                parts = ip.split(":")
                if len(parts) >= 2:
                    return f"{parts[0]}:{parts[1]}::*"
                return None
            parts = ip.split(".")
            if len(parts) == 4:
                return f"{parts[0]}.{parts[1]}.{parts[2]}.*"
            return None
        except Exception:
            return None

    def _migrate_whitelist_from_txt(self) -> bool:
        if not os.path.exists(self.whitelist_txt_path):
            return False

        try:
            with open(self.whitelist_txt_path, "r", encoding="utf-8") as f:
                txt_content = f.read()

            migrated_ips = []
            for line in txt_content.split("\n"):
                line = line.strip()
                if line and line not in migrated_ips:
                    migrated_ips.append(line)

            current_ips = set(self.whitelist_ips)
            new_ips = [ip for ip in migrated_ips if ip not in current_ips]

            if new_ips:
                self.whitelist_ips = migrated_ips + [
                    ip for ip in self.whitelist_ips if ip not in migrated_ips
                ]
                self.save_config()
                app_logger.info(
                    f"已从 whitelist.txt 迁移 {len(new_ips)} 个 IP 到 config.yaml"
                )
                # 仅在迁移成功并保存配置后才删除旧文件
                try:
                    os.remove(self.whitelist_txt_path)
                    app_logger.info("已删除旧的 whitelist.txt 文件")
                except Exception as e:
                    app_logger.warning(f"删除 whitelist.txt 失败: {str(e)}")

            return True

        except Exception as e:
            app_logger.error(f"迁移 whitelist.txt 失败: {str(e)}")
            return False

    def _check_and_update_whitelist_subnet(self):
        """
        检查并更新白名单中的网段
        如果检测到白名单中的网段与当前设备网络不匹配，则进行更新
        """
        local_ip = get_network_manager().get_local_ip()
        if not local_ip:
            app_logger.warning("无法获取本地IP，跳过白名单网段检查")
            return False

        current_subnet = self._get_subnet_from_ip(local_ip)
        if not current_subnet:
            app_logger.warning(f"无法从IP {local_ip} 提取网段")
            return False

        is_ipv6 = ":" in local_ip
        broader_subnet = None
        if not is_ipv6:
            ip_parts = local_ip.split(".")
            broader_subnet = f"{ip_parts[0]}.{ip_parts[1]}.*.*"

        subnet_exists = any(
            ip == current_subnet or (broader_subnet and ip == broader_subnet)
            for ip in self.whitelist_ips
        )

        if subnet_exists:
            return False

        new_whitelist = []
        for ip in self.whitelist_ips:
            if ip == "127.0.0.1" or ip == "::1":
                new_whitelist.append(ip)
            elif "*" not in ip and ("." in ip or ":" in ip):
                new_whitelist.append(ip)
            elif "*" in ip:
                if is_ipv6:
                    ip_prefix = ip.split(":")[0] if ":" in ip else ""
                    local_prefix = local_ip.split(":")[0]
                    if ip_prefix and ip_prefix != local_prefix:
                        new_whitelist.append(ip)
                else:
                    ip_parts_local = local_ip.split(".")
                    ip_prefix = ip.split(".")[0] if "." in ip else ""
                    if (
                        ip_prefix
                        and ip_prefix.isdigit()
                        and ip_prefix != ip_parts_local[0]
                    ):
                        new_whitelist.append(ip)

        if current_subnet not in new_whitelist:
            new_whitelist.insert(0, current_subnet)
        if "127.0.0.1" not in new_whitelist:
            new_whitelist.append("127.0.0.1")
        if "::1" not in new_whitelist:
            new_whitelist.append("::1")

        self.whitelist_ips = new_whitelist
        self.save_config()
        app_logger.info(f"白名单网段已更新: {current_subnet} (本地IP: {local_ip})")
        return True

    def create_whitelist(self):
        """
        创建或更新 IP 白名单配置
        如果白名单中没有当前设备的网段，则自动添加

        Returns:
            bool: 操作是否成功
        """
        local_ip = get_network_manager().get_local_ip()

        try:
            if local_ip:
                subnet = self._get_subnet_from_ip(local_ip)
                if subnet and subnet not in self.whitelist_ips:
                    self.whitelist_ips.insert(0, subnet)
                    if "127.0.0.1" not in self.whitelist_ips:
                        self.whitelist_ips.append("127.0.0.1")
                    if "::1" not in self.whitelist_ips:
                        self.whitelist_ips.append("::1")
                    self.save_config()
                    app_logger.info(
                        f"白名单已更新，添加网段: {subnet} (本地IP: {local_ip})"
                    )
                elif not subnet:
                    app_logger.warning(f"无法提取网段 (本地IP: {local_ip})")
            else:
                app_logger.warning("无法获取本地IP，白名单未更新")
            return True
        except Exception as e:
            app_logger.error(f"白名单更新失败: {str(e)}")
            return False

    def sync_whitelists(self, source: str = "ip"):
        """
        同步白名单内容

        Args:
            source: 同步源，"ip" 表示从 IP 白名单同步到 Host 白名单，
                   "host" 表示从 Host 白名单同步到 IP 白名单

        当 unified_whitelist 为 True 时，自动同步两个白名单
        """
        import re

        def is_valid_ip_or_pattern(entry: str) -> bool:
            if not entry:
                return False
            if entry == "localhost":
                return False
            ipv4_pattern = r"^(\d{1,3}\.){3}\d{1,3}(\.\*)?$"
            ipv6_pattern = r"^[0-9a-fA-F:]+::?[0-9a-fA-F:]*$|^\[[0-9a-fA-F:]+\]$|^[0-9a-fA-F:]+::\*$"
            ipv4_cidr = r"^(\d{1,3}\.){3}\d{1,3}/\d{1,2}$"
            ipv6_cidr = r"^[0-9a-fA-F:]+/\d{1,3}$"
            wildcard = r"^(\d{1,3}\.){0,3}\*$|^(\d{1,3}\.){0,2}\*\.\*$"
            return bool(
                re.match(ipv4_pattern, entry)
                or re.match(ipv6_pattern, entry)
                or re.match(ipv4_cidr, entry)
                or re.match(ipv6_cidr, entry)
                or re.match(wildcard, entry)
            )

        if source == "ip":
            new_hosts = []
            if "localhost" in self.host_whitelist_hosts:
                new_hosts.append("localhost")
            for ip in self.whitelist_ips:
                if ":" in ip and not ip.startswith("["):
                    new_hosts.append(f"[{ip}]")
                else:
                    new_hosts.append(ip)
            self.host_whitelist_hosts = new_hosts
        else:
            new_ips = []
            for host in self.host_whitelist_hosts:
                if host == "localhost":
                    continue
                if host.startswith("[") and host.endswith("]"):
                    inner = host[1:-1]
                    if is_valid_ip_or_pattern(inner):
                        new_ips.append(inner)
                elif is_valid_ip_or_pattern(host):
                    new_ips.append(host)
            self.whitelist_ips = new_ips

        self.save_config()
        app_logger.info(
            f"白名单已同步: {source} -> {'host' if source == 'ip' else 'ip'}"
        )
