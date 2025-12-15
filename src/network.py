#!/usr/bin/env python3
"""
Network utilities for SillyTavern Launcher
IP address detection and network-related functions
"""

import time
import subprocess
import re
import socket
from typing import Optional


class NetworkManager:
    """Network utilities manager"""

    def __init__(self, cache_duration: int = 300, log_callback=None):
        """
        Initialize network manager

        Args:
            cache_duration: IP cache duration in seconds (default: 300)
            log_callback: Optional callback function for logging messages
        """
        self._cached_local_ip = None
        self._last_ip_check_time = 0
        self._ip_cache_duration = cache_duration
        self._log_callback = log_callback

    def _log(self, message: str, level: str = 'info'):
        """
        Log message to callback if available, otherwise print

        Args:
            message: Log message
            level: Log level ('info', 'success', 'warning', 'error')
        """
        if self._log_callback:
            try:
                self._log_callback(message, level)
            except Exception:
                print(message)
        else:
            print(message)

    def get_local_ip(self) -> Optional[str]:
        """
        获取本机局域网IP地址（带缓存）

        Returns:
            str: 本机局域网IP地址，如果获取失败则返回None
        """
        current_time = time.time()

        # 如果缓存仍然有效，直接返回缓存的IP
        if (self._cached_local_ip and
            current_time - self._last_ip_check_time < self._ip_cache_duration):
            # 缓存有效，直接返回（不打印任何信息避免干扰）
            return self._cached_local_ip

        try:
            # 只有在缓存过期时才执行ipconfig命令获取网络配置信息
            self._log("IP缓存已过期，执行ipconfig命令获取新IP...", 'info')
            result = subprocess.run(['ipconfig'], capture_output=True, text=True, shell=True)

            if result.returncode != 0:
                self._log(f"ipconfig命令执行失败: {result.stderr}", 'error')
                return self._fallback_get_local_ip()

            output = result.stdout

            # 使用正则表达式查找IPv4地址
            # 匹配模式：IPv4 地址 . . . . . . . . . . . : 192.168.1.100
            ipv4_pattern = r'IPv4 地址[\. ]+\: ([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})'
            # 备用匹配模式：IP Address. . . . . . . . . . . : 192.168.1.100
            ipv4_pattern_en = r'IP Address[\. ]+\: ([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})'

            # 查找所有匹配的IP地址
            ips_chinese = re.findall(ipv4_pattern, output)
            ips_english = re.findall(ipv4_pattern_en, output)
            all_ips = ips_chinese + ips_english

            if all_ips:
                # 过滤出有效的IP地址
                valid_ips = []
                for ip in all_ips:
                    if self._is_valid_ip(ip) and not ip.startswith("127.") and not ip.startswith("169.254."):
                        valid_ips.append(ip)

                if valid_ips:
                    # 按优先级排序，选择优先级最高的IP
                    valid_ips.sort(key=lambda ip: self._get_ip_priority(ip))
                    best_ip = valid_ips[0]

                    # 缓存结果并更新时间戳
                    self._cached_local_ip = best_ip
                    self._last_ip_check_time = current_time

                    # 根据IP类型记录不同的日志信息
                    if best_ip.startswith("192.168."):
                        self._log(f"通过ipconfig获取优选内网IP(192.168.x.x): {best_ip}", 'success')
                    elif self._is_valid_lan_ip(best_ip):
                        self._log(f"通过ipconfig获取内网IP: {best_ip}", 'success')
                    else:
                        self._log(f"通过ipconfig获取IP: {best_ip}", 'info')

                    return best_ip

        except Exception as e:
            self._log(f"使用ipconfig获取IP失败: {e}", 'error')

        # 如果ipconfig失败，使用备用方法
        fallback_ip = self._fallback_get_local_ip()
        if fallback_ip:
            self._cached_local_ip = fallback_ip
            self._last_ip_check_time = current_time
        return fallback_ip

    def _fallback_get_local_ip(self) -> Optional[str]:
        """
        备用方法获取本机IP地址

        Returns:
            str: 本机IP地址，如果获取失败则返回None
        """
        try:
            # 方法1: 连接外部DNS获取IP
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(3)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()

            if self._is_valid_ip(local_ip):
                self._log(f"通过备用方法获取IP: {local_ip}", 'info')
                return local_ip
        except Exception as e:
            self._log(f"备用方法获取IP失败: {e}", 'error')

        return None

    def _is_valid_lan_ip(self, ip: str) -> bool:
        """
        验证是否为有效的局域网IP地址

        Args:
            ip (str): 要验证的IP地址

        Returns:
            bool: 是否为有效的局域网IP地址
        """
        try:
            parts = ip.split('.')
            if len(parts) != 4:
                return False

            for part in parts:
                num = int(part)
                if num < 0 or num > 255:
                    return False

            # 排除特殊地址
            if ip.startswith("127.") or ip.startswith("169.254."):
                return False

            # 检查是否为内网地址
            first_octet = int(parts[0])
            second_octet = int(parts[1])

            # 私有IP地址范围：
            # 10.0.0.0 - 10.255.255.255 (Class A)
            # 172.16.0.0 - 172.31.255.255 (Class B)
            # 192.168.0.0 - 192.168.255.255 (Class C)
            if (first_octet == 10) or \
               (first_octet == 172 and 16 <= second_octet <= 31) or \
               (first_octet == 192 and second_octet == 168):
                return True

            return False
        except (ValueError, AttributeError, IndexError):
            return False

    def _get_ip_priority(self, ip: str) -> int:
        """
        获取IP地址的优先级，数值越小优先级越高

        Args:
            ip (str): IP地址

        Returns:
            int: 优先级数值（0为最高优先级）
        """
        try:
            parts = ip.split('.')
            if len(parts) != 4:
                return 999  # 无效IP最低优先级

            first_octet = int(parts[0])
            second_octet = int(parts[1])

            # 优先级排序：
            # 1. 192.168.x.x (最高优先级)
            # 2. 10.x.x.x
            # 3. 172.16-31.x.x
            # 4. 其他有效IP
            if first_octet == 192 and second_octet == 168:
                return 1  # 192.168.x.x 最高优先级
            elif first_octet == 10:
                return 2  # 10.x.x.x 次优先级
            elif first_octet == 172 and 16 <= second_octet <= 31:
                return 3  # 172.16-31.x.x 较低优先级
            elif self._is_valid_ip(ip):
                return 4  # 其他有效IP最低优先级
            else:
                return 999  # 无效IP
        except (ValueError, AttributeError, IndexError):
            return 999

    def _is_valid_ip(self, ip: str) -> bool:
        """
        验证IP地址格式是否有效

        Args:
            ip (str): 要验证的IP地址

        Returns:
            bool: IP地址是否有效
        """
        try:
            parts = ip.split('.')
            if len(parts) != 4:
                return False

            for part in parts:
                num = int(part)
                if num < 0 or num > 255:
                    return False

            # 排除特殊地址
            if ip.startswith("127.") or ip.startswith("169.254."):
                return False

            return True
        except (ValueError, AttributeError):
            return False


# Global singleton instance
_global_network_manager = None

def get_network_manager() -> NetworkManager:
    """
    Get the global NetworkManager instance (singleton pattern)

    Returns:
        NetworkManager: The global network manager instance
    """
    global _global_network_manager
    if _global_network_manager is None:
        _global_network_manager = NetworkManager()
    return _global_network_manager

def get_local_ip() -> Optional[str]:
    """
    Convenience function to get local IP using the global NetworkManager

    Returns:
        str: Local IP address or None if failed
    """
    return get_network_manager().get_local_ip()