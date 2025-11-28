#!/usr/bin/env python3
"""
SillyTavern Data Sync Manager
Unified sync management for PC Launcher
"""

import os
import json
import time
import socket
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Tuple

try:
    from sync_server import SyncServer
    from sync_client import SyncClient
except ImportError as e:
    # Create dummy classes to handle import errors gracefully
    print(f"警告: 无法导入同步模块，某些功能将不可用: {e}")

    class SyncServer:
        def __init__(self, *args, **kwargs):
            raise ImportError("Flask未安装，无法使用同步服务器功能")

    class SyncClient:
        def __init__(self, *args, **kwargs):
            raise ImportError("requests未安装，无法使用同步客户端功能")


class DataSyncManager:
    """Unified data sync manager for PC Launcher"""

    def __init__(self, data_dir: str, config_manager=None):
        """
        Initialize sync manager (non-blocking)

        Args:
            data_dir: SillyTavern data directory
            config_manager: Configuration manager instance
        """
        self.data_dir = data_dir
        self.config_manager = config_manager
        self.sync_server: Optional[SyncServer] = None
        self.sync_thread: Optional[threading.Thread] = None
        self.is_server_running = False
        self.sync_status = "idle"  # idle, syncing, server, error
        self.last_sync_info = {}

        # Load sync configuration
        self._load_config()

        # Cache for local IP to avoid repeated system calls
        self._cached_local_ip = None
        self._last_ip_check_time = 0
        self._ip_cache_duration = 300  # Cache IP for 5 minutes (reduced frequency)

        # Don't print initialization messages here - they block the UI
        # Messages will be printed in async_initialize() method

    async def async_initialize(self):
        """Asynchronous initialization that can print messages without blocking UI"""
        print("数据同步管理器已初始化")
        print(f"数据目录: {self.data_dir}")
        print(f"服务器状态: {'启用' if self.server_enabled else '禁用'}")
        return True

    def _load_config(self):
        """Load sync configuration"""
        if self.config_manager:
            self.server_enabled = self.config_manager.get("sync.enabled", False)
            self.server_port = self.config_manager.get("sync.port", 9999)
            self.server_host = self.config_manager.get("sync.host", "0.0.0.0")
        else:
            self.server_enabled = False
            self.server_port = 9999
            self.server_host = "0.0.0.0"

    def _save_config(self):
        """Save sync configuration"""
        if self.config_manager:
            self.config_manager.set("sync.enabled", self.server_enabled)
            self.config_manager.set("sync.port", self.server_port)
            self.config_manager.set("sync.host", self.server_host)
            self.config_manager.save_config()

    def get_server_url(self) -> str:
        """Get current server URL"""
        if self.server_enabled:
            local_ip = self._get_local_ip()
            return f"http://{local_ip}:{self.server_port}"
        return ""

    def detect_network_servers(self, timeout: int = 5, port: int = None) -> List[Tuple[str, Dict]]:
        """
        Detect SillyTavern sync servers on local network

        Args:
            timeout: Request timeout in seconds
            port: Port to scan (default uses configured port)

        Returns:
            List of (server_url, server_info) tuples
        """
        print("正在扫描局域网中的 SillyTavern 同步服务器...")

        try:
            import requests

            # Get local IP and network range using multiple fallback methods
            local_ip = self._get_local_ip()
            if not local_ip:
                print("无法获取本机IP地址")
                return []

            # Extract network segment
            ip_parts = local_ip.split('.')
            network_base = '.'.join(ip_parts[:3])
            scan_port = port or self.server_port

            print(f"本地IP地址: {local_ip}")
            print(f"扫描网络段: {network_base}.0/24")
            print(f"扫描端口: {scan_port}")

            # Scan network range
            result_queue = []
            threads = []

            def check_ip(ip):
                url = f"http://{ip}:{scan_port}/health"
                try:
                    response = requests.get(url, timeout=timeout)
                    if response.status_code == 200:
                        data = response.json()
                        result_queue.append((ip, True, data))
                    else:
                        result_queue.append((ip, False, None))
                except:
                    result_queue.append((ip, False, None))

            # Scan common IP ranges based on local IP
            if local_ip.startswith('192.168'):
                # Scan last octet from 1 to 254
                for i in range(1, 255):
                    ip = f"{network_base}.{i}"
                    if ip != local_ip:  # Skip self
                        thread = threading.Thread(target=check_ip, args=(ip,))
                        threads.append(thread)
                        thread.start()

            elif local_ip.startswith('10.'):
                # Limited scan for 10.x.x.x networks
                for i in range(1, 100):
                    ip = f"{network_base}.{i}"
                    if ip != local_ip:
                        thread = threading.Thread(target=check_ip, args=(ip,))
                        threads.append(thread)
                        thread.start()

            # Wait for threads to complete
            for thread in threads:
                thread.join()

            # Collect results
            servers = []
            for ip, success, data in result_queue:
                if success:
                    servers.append((f"http://{ip}:{scan_port}", data))

            if servers:
                print(f"\n发现 {len(servers)} 个 SillyTavern 同步服务器:")
                for i, (server_url, data) in enumerate(servers, 1):
                    data_path = data.get('data_path', 'N/A')
                    timestamp = data.get('timestamp', 'N/A')
                    print(f"  {i}. {server_url} - 数据路径: {data_path} - 时间: {timestamp}")
            else:
                print("\n未发现 SillyTavern 同步服务器")
                print("请确保:")
                print("  1. 目标设备已启动 SillyTavern 同步服务")
                print("  2. 设备在同一局域网内")
                print("  3. 防火墙允许端口访问")

            return servers

        except Exception as e:
            print(f"网络扫描失败: {e}")
            return []

    def start_sync_server(self, port: int = None, host: str = None) -> bool:
        """
        Start sync server

        Args:
            port: Server port (default uses configured port)
            host: Server host (default uses configured host)

        Returns:
            bool: Success status
        """
        if self.is_server_running:
            print("数据同步服务已在运行")
            return True

        if not os.path.exists(self.data_dir):
            print(f"错误: 数据目录不存在: {self.data_dir}")
            return False

        try:
            self.server_port = port or self.server_port
            self.server_host = host or self.server_host

            # Initialize sync server
            self.sync_server = SyncServer(
                data_path=self.data_dir,
                port=self.server_port,
                host=self.server_host
            )

            # Start server in background thread
            def run_server():
                self.sync_server.app.run(
                    host=self.server_host,
                    port=self.server_port,
                    debug=False
                )

            self.sync_thread = threading.Thread(target=run_server, daemon=True)
            self.sync_thread.start()

            self.is_server_running = True
            self.server_enabled = True
            self.sync_status = "server"

            # Save configuration
            self._save_config()

            local_ip = self._get_local_ip()
            print(f"数据同步服务已启动!")
            print(f"服务器地址: http://{local_ip}:{self.server_port}")
            print(f"本地地址: http://localhost:{self.server_port}")
            print(f"数据路径: {self.data_dir}")

            return True

        except Exception as e:
            print(f"启动同步服务器失败: {e}")
            self.sync_status = "error"
            return False

    def stop_sync_server(self) -> bool:
        """Stop sync server"""
        if not self.is_server_running:
            print("数据同步服务未运行")
            return True

        try:
            self.is_server_running = False
            self.server_enabled = False
            self.sync_status = "idle"

            # Note: Flask server in background thread is hard to stop gracefully
            # For now, we mark it as stopped
            if self.sync_server:
                self.sync_server.running = False

            # Save configuration
            self._save_config()

            print("数据同步服务已停止")
            return True

        except Exception as e:
            print(f"停止同步服务器失败: {e}")
            return False

    def sync_from_server(self, server_url: str, method: str = 'auto', backup: bool = True) -> bool:
        """
        Sync data from remote server

        Args:
            server_url: Remote server URL
            method: Sync method ('auto', 'zip', 'incremental')
            backup: Whether to backup existing data

        Returns:
            bool: Success status
        """
        if self.is_server_running:
            print("错误: 服务器正在运行时无法同步数据")
            return False

        try:
            self.sync_status = "syncing"

            # Ensure data directory exists
            os.makedirs(self.data_dir, exist_ok=True)

            # Initialize sync client
            client = SyncClient(server_url, self.data_dir)

            # Check server health
            if not client.check_server_health():
                print("无法连接到服务器或服务器不健康")
                self.sync_status = "error"
                return False

            # Get server info
            server_info = client.get_server_info()
            if server_info:
                info = server_info.get('server_info', {})
                print(f"服务器信息:")
                print(f"  文件数量: {info.get('file_count', 0)}")
                print(f"  总大小: {client._format_size(info.get('total_size', 0))}")

                # Store sync info
                self.last_sync_info = {
                    'server_url': server_url,
                    'method': method,
                    'timestamp': datetime.now().isoformat(),
                    'server_info': info,
                    'success': False
                }

            # Perform sync
            print(f"开始从服务器同步: {server_url}")
            print(f"同步方法: {method}")
            print(f"备份现有数据: {'是' if backup else '否'}")

            success = client.sync(
                prefer_zip=(method == 'auto' or method == 'zip'),
                backup=backup
            )

            # Update sync status
            self.last_sync_info['success'] = success

            if success:
                print("数据同步完成!")
                self.sync_status = "idle"
                return True
            else:
                print("数据同步失败!")
                self.sync_status = "error"
                return False

        except Exception as e:
            print(f"数据同步过程中发生错误: {e}")
            self.sync_status = "error"
            return False

    def get_data_info(self) -> Dict:
        """Get data directory information"""
        info = {
            'data_dir': self.data_dir,
            'exists': os.path.exists(self.data_dir),
            'size': 0,
            'file_count': 0
        }

        if info['exists']:
            total_size = 0
            file_count = 0
            for root, dirs, files in os.walk(self.data_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    try:
                        total_size += os.path.getsize(file_path)
                        file_count += 1
                    except:
                        continue

            info['size'] = total_size
            info['size_formatted'] = self._format_size(total_size)
            info['file_count'] = file_count

        return info

    def get_sync_info(self) -> Dict:
        """Get current sync status and information"""
        return {
            'status': self.sync_status,
            'is_server_running': self.is_server_running,
            'server_enabled': self.server_enabled,
            'server_host': self.server_host,
            'server_port': self.server_port,
            'server_url': self.get_server_url() if self.server_enabled else "",
            'local_ip': self._get_local_ip(),
            'last_sync': self.last_sync_info,
            'data_info': self.get_data_info()
        }

    def _format_size(self, size_bytes: int) -> str:
        """Format file size in human readable format"""
        if size_bytes == 0:
            return "0B"

        size_names = ["B", "KB", "MB", "GB"]
        i = 0
        while size_bytes >= 1024 and i < len(size_names) - 1:
            size_bytes /= 1024.0
            i += 1

        return f"{size_bytes:.1f}{size_names[i]}"

    def _get_local_ip(self):
        """
        使用ipconfig命令获取本机局域网IP地址（带缓存）

        Returns:
            str: 本机局域网IP地址，如果获取失败则返回None
        """
        import time
        import subprocess
        import re

        current_time = time.time()

        # 如果缓存仍然有效，直接返回缓存的IP
        if (self._cached_local_ip and
            current_time - self._last_ip_check_time < self._ip_cache_duration):
            # 缓存有效，直接返回（不打印任何信息避免干扰）
            return self._cached_local_ip

        try:
            # 只有在缓存过期时才执行ipconfig命令获取网络配置信息
            print(f"IP缓存已过期，执行ipconfig命令获取新IP...")
            result = subprocess.run(['ipconfig'], capture_output=True, text=True, shell=True)

            if result.returncode != 0:
                print(f"ipconfig命令执行失败: {result.stderr}")
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

            # 过滤并选择最佳的内网IP
            for ip in all_ips:
                if self._is_valid_lan_ip(ip):
                    # 缓存结果并更新时间戳
                    self._cached_local_ip = ip
                    self._last_ip_check_time = current_time
                    print(f"通过ipconfig获取内网IP: {ip}")
                    return ip

            # 如果没找到合适的内网IP，返回第一个有效的IP
            for ip in all_ips:
                if self._is_valid_ip(ip) and not ip.startswith("127.") and not ip.startswith("169.254."):
                    # 缓存结果并更新时间戳
                    self._cached_local_ip = ip
                    self._last_ip_check_time = current_time
                    print(f"通过ipconfig获取IP: {ip}")
                    return ip

        except Exception as e:
            print(f"使用ipconfig获取IP失败: {e}")

        # 如果ipconfig失败，使用备用方法
        fallback_ip = self._fallback_get_local_ip()
        if fallback_ip:
            self._cached_local_ip = fallback_ip
            self._last_ip_check_time = current_time
        return fallback_ip

    def _fallback_get_local_ip(self):
        """
        备用方法获取本机IP地址

        Returns:
            str: 本机IP地址，如果获取失败则返回None
        """
        import socket

        try:
            # 方法1: 连接外部DNS获取IP
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(3)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()

            if self._is_valid_ip(local_ip):
                print(f"通过备用方法获取IP: {local_ip}")
                return local_ip
        except Exception as e:
            print(f"备用方法获取IP失败: {e}")

        return None

    def _is_valid_lan_ip(self, ip):
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

    def _is_valid_ip(self, ip):
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