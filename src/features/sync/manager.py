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
    from features.sync.server import SyncServer
    from features.sync.client import SyncClient
except ImportError as e:
    # Create dummy classes to handle import errors gracefully
    print(f"警告: 无法导入同步模块，某些功能将不可用: {e}")

    class SyncServer:
        def __init__(self, *args, **kwargs):
            raise ImportError("Flask未安装，无法使用同步服务器功能")

    class SyncClient:
        def __init__(self, *args, **kwargs):
            raise ImportError("requests未安装，无法使用同步客户端功能")

try:
    from core.network import get_network_manager
except ImportError as e:
    print(f"警告: 无法导入网络模块: {e}")
    def get_network_manager():
        return None


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

        # Get the global network manager
        self.network_manager = get_network_manager()
        if self.network_manager:
            self.network_manager._log_callback = self._log

        # UI callback for log messages
        self._ui_log_callback = None

        # Load sync configuration (now after cache variables are initialized)
        self._load_config()

        # Don't print initialization messages here - they block the UI
        # Messages will be printed in async_initialize() method

    def set_ui_log_callback(self, callback):
        """
        Set UI callback for log messages

        Args:
            callback: Function to call with log messages (message, level)
        """
        self._ui_log_callback = callback

    def _log(self, message: str, level: str = 'info'):
        """
        Log message to UI if callback is available, otherwise print

        Args:
            message: Log message
            level: Log level ('info', 'success', 'warning', 'error')
        """
        if self._ui_log_callback:
            try:
                self._ui_log_callback(message, level)
            except Exception:
                # Fallback to print if UI callback fails
                print(message)
        else:
            print(message)

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
            # 获取局域网IP作为默认主机地址，确保只在局域网内工作
            default_lan_ip = self.network_manager.get_local_ip() if self.network_manager else None
            default_lan_ip = default_lan_ip or "192.168.1.100"
            self.server_host = self.config_manager.get("sync.host", default_lan_ip)
        else:
            self.server_enabled = False
            self.server_port = 9999
            # 在没有配置管理器时，也使用局域网IP而不是0.0.0.0
            fallback_lan_ip = self.network_manager.get_local_ip() if self.network_manager else None
            fallback_lan_ip = fallback_lan_ip or "192.168.1.100"
            self.server_host = fallback_lan_ip

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
            local_ip = self.network_manager.get_local_ip() if self.network_manager else "localhost"
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
        self._log("正在扫描局域网中的 SillyTavern 同步服务器...", 'info')

        try:
            import requests

            # Get local IP and network range using multiple fallback methods
            local_ip = self.network_manager.get_local_ip() if self.network_manager else None
            if not local_ip:
                self._log("无法获取本机IP地址", 'error')
                return []

            # Extract network segment
            ip_parts = local_ip.split('.')
            network_base = '.'.join(ip_parts[:3])
            scan_port = port or self.server_port

            self._log(f"本地IP地址: {local_ip}", 'info')
            self._log(f"扫描网络段: {network_base}.0/24", 'info')
            self._log(f"扫描端口: {scan_port}", 'info')

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
                self._log(f"发现 {len(servers)} 个 SillyTavern 同步服务器:", 'success')
                for i, (server_url, data) in enumerate(servers, 1):
                    data_path = data.get('data_path', 'N/A')
                    timestamp = data.get('timestamp', 'N/A')
                    self._log(f"  {i}. {server_url} - 数据路径: {data_path} - 时间: {timestamp}", 'info')
            else:
                self._log("未发现 SillyTavern 同步服务器", 'warning')
                self._log("请确保:", 'warning')
                self._log("  1. 目标设备已启动 SillyTavern 同步服务", 'warning')
                self._log("  2. 设备在同一局域网内", 'warning')
                self._log("  3. 防火墙允许端口访问", 'warning')

            return servers

        except Exception as e:
            self._log(f"网络扫描失败: {e}", 'error')
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
            self._log("数据同步服务已在运行", 'warning')
            return True

        if not os.path.exists(self.data_dir):
            self._log(f"错误: 数据目录不存在: {self.data_dir}", 'error')
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

            # Set log callback to pass through messages to UI
            self.sync_server.set_ui_log_callback(self._log)

            # 使用可关闭的 Flask 服务器
            from werkzeug.serving import make_server

            def run_server():
                self.sync_server.httpd = make_server(
                    self.server_host,
                    self.server_port,
                    self.sync_server.app,
                    threaded=True
                )
                self.sync_server.httpd.serve_forever()

            self.sync_thread = threading.Thread(target=run_server, daemon=False)
            self.sync_thread.start()

            self.is_server_running = True
            self.server_enabled = True
            self.sync_status = "server"

            # Save configuration
            self._save_config()

            local_ip = self.network_manager.get_local_ip() if self.network_manager else "localhost"
            self._log(f"数据同步服务已启动!", 'success')
            self._log(f"服务器地址: http://{local_ip}:{self.server_port}", 'info')
            self._log(f"本地地址: http://localhost:{self.server_port}", 'info')
            self._log(f"数据路径: {self.data_dir}", 'info')

            return True

        except Exception as e:
            self._log(f"启动同步服务器失败: {e}", 'error')
            self.sync_status = "error"
            return False

    def stop_sync_server(self) -> bool:
        """Stop sync server"""
        if not self.is_server_running:
            self._log("数据同步服务未运行", 'info')
            return True

        try:
            self.is_server_running = False
            self.server_enabled = False
            self.sync_status = "idle"

            # 优雅关闭 Flask 服务器
            if self.sync_server and hasattr(self.sync_server, 'httpd'):
                self.sync_server.running = False
                self.sync_server.httpd.shutdown()

                # 等待服务器线程结束
                if self.sync_thread and self.sync_thread.is_alive():
                    self.sync_thread.join(timeout=5.0)

                self._log("数据同步服务已停止", 'info')
            else:
                # 回退到原有方法
                if self.sync_server:
                    self.sync_server.running = False
                self._log("数据同步服务已停止", 'info')

            # Save configuration
            self._save_config()

            return True

        except Exception as e:
            self._log(f"停止同步服务器失败: {e}", 'error')
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
            'local_ip': self.network_manager.get_local_ip() if self.network_manager else None,
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

    