#!/usr/bin/env python3
"""
SillyTavern Data Sync Client
Python client for synchronizing SillyTavern user data from remote server
"""

import os
import json
import requests
import zipfile
import io
import shutil
import time
from datetime import datetime, timedelta
from pathlib import Path
import tempfile
import argparse


class SyncClient:
    def __init__(self, server_url, data_path=None, timeout=30):
        """
        Initialize sync client

        Args:
            server_url (str): Base URL of sync server (e.g., http://192.168.1.100:9999)
            data_path (str): Local SillyTavern data directory
            timeout (int): Request timeout in seconds
        """
        self.server_url = server_url.rstrip('/')
        self.data_path = data_path or self._find_data_path()
        self.timeout = timeout
        self.session = requests.Session()

        # Ensure data directory exists
        os.makedirs(self.data_path, exist_ok=True)

        print(f"数据同步客户端已初始化")
        print(f"服务器地址: {self.server_url}")
        print(f"本地数据路径: {self.data_path}")

    def _find_data_path(self):
        """Auto-detect SillyTavern data path"""
        possible_paths = [
            os.path.join(os.getcwd(), "SillyTavern", "data", "default-user"),
            os.path.join(os.getcwd(), "data", "default-user"),
            os.path.expanduser("~/SillyTavern/data/default-user"),
            "./SillyTavern/data/default-user"
        ]

        for path in possible_paths:
            if os.path.exists(path) or os.path.exists(os.path.dirname(path)):
                print(f"检测到数据目录: {path}")
                return path

        # Fallback to current directory structure
        default_path = os.path.join(os.getcwd(), "SillyTavern", "data", "default-user")
        print(f"未找到数据目录，使用默认路径: {default_path}")
        return default_path

    def _request(self, endpoint, method='GET', params=None, stream=False):
        """Make HTTP request to server"""
        url = f"{self.server_url}/{endpoint}"
        try:
            response = self.session.request(
                method, url, params=params, timeout=self.timeout, stream=stream
            )
            response.raise_for_status()
            return response
        except requests.exceptions.RequestException as e:
            raise Exception(f"请求失败 {endpoint}: {str(e)}")

    def check_server_health(self):
        """Check if server is healthy and accessible"""
        try:
            response = self._request('health')
            data = response.json()
            print(f"服务器状态: 健康")
            print(f"服务器数据路径: {data.get('data_path', 'N/A')}")
            return True
        except Exception as e:
            print(f"服务器健康检查失败: {e}")
            return False

    def get_server_info(self):
        """Get server information"""
        try:
            response = self._request('info')
            return response.json()
        except Exception as e:
            print(f"获取服务器信息失败: {e}")
            return None

    def get_remote_manifest(self):
        """Get file manifest from remote server"""
        try:
            response = self._request('manifest')
            data = response.json()
            if data.get('success'):
                return data['manifest']
            else:
                raise Exception(data.get('error', '未知错误'))
        except Exception as e:
            print(f"获取远程文件清单失败: {e}")
            return None

    def get_local_manifest(self):
        """Generate local file manifest"""
        manifest = []

        for root, dirs, files in os.walk(self.data_path):
            # Skip hidden directories
            dirs[:] = [d for d in dirs if not d.startswith('.')]

            for file in files:
                # Skip hidden files and temporary files
                if file.startswith('.') or file.endswith('.tmp'):
                    continue

                file_path = os.path.join(root, file)
                relative_path = os.path.relpath(file_path, self.data_path)

                try:
                    stat_info = os.stat(file_path)
                    manifest.append({
                        'path': relative_path.replace('\\', '/'),  # Normalize to forward slashes
                        'size': stat_info.st_size,
                        'mtime': stat_info.st_mtime,
                        'modified': datetime.fromtimestamp(stat_info.st_mtime).isoformat(),
                        'is_dir': False
                    })
                except OSError:
                    # Skip files that can't be accessed
                    continue

        return manifest

    def sync_full_zip(self, backup=True):
        """
        Synchronize using full ZIP download

        Args:
            backup (bool): Whether to backup existing data

        Returns:
            bool: Success status
        """
        print("开始 ZIP 全量同步...")

        if backup:
            if not self._backup_existing_data():
                print("备份失败，取消同步")
                return False

        try:
            # Download ZIP file
            print("正在下载 ZIP 文件...")
            response = self._request('zip', stream=True)

            # Create temporary zip file
            with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as temp_file:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        temp_file.write(chunk)
                temp_zip_path = temp_file.name

            # Extract ZIP file
            print("正在解压 ZIP 文件...")
            self._extract_zip_with_progress(temp_zip_path, self.data_path)

            # Clean up temp file
            os.unlink(temp_zip_path)

            print("ZIP 全量同步完成")
            return True

        except Exception as e:
            print(f"ZIP 同步失败: {e}")
            if backup:
                print("尝试恢复备份...")
                self._restore_backup()
            return False

    def sync_incremental(self):
        """
        Synchronize using incremental file-by-file approach

        Returns:
            bool: Success status
        """
        print("开始增量同步...")

        try:
            # Get remote and local manifests
            print("获取文件清单...")
            remote_manifest = self.get_remote_manifest()
            local_manifest = self.get_local_manifest()

            if not remote_manifest:
                print("无法获取远程文件清单")
                return False

            # Create local manifest lookup
            local_files = {item['path']: item for item in local_manifest}

            # Analyze differences
            files_to_download = []
            files_to_delete = []
            total_size = 0

            for remote_file in remote_manifest:
                path = remote_file['path']
                local_file = local_files.get(path)

                if not local_file:
                    # File exists remotely but not locally - download
                    files_to_download.append(remote_file)
                    total_size += remote_file['size']
                elif remote_file['mtime'] > local_file['mtime']:
                    # Remote file is newer - download
                    files_to_download.append(remote_file)
                    total_size += remote_file['size']

            # Check for local files that don't exist remotely
            for local_path in local_files:
                if local_path not in [f['path'] for f in remote_manifest]:
                    files_to_delete.append(local_path)

            if not files_to_download and not files_to_delete:
                print("数据已是最新，无需同步")
                return True

            print(f"需要下载 {len(files_to_download)} 个文件 ({self._format_size(total_size)})")
            print(f"需要删除 {len(files_to_delete)} 个文件")

            # Delete obsolete files
            for file_path in files_to_delete:
                full_path = os.path.join(self.data_path, file_path)
                try:
                    os.remove(full_path)
                    print(f"已删除: {file_path}")
                except Exception as e:
                    print(f"删除文件失败 {file_path}: {e}")

            # Download new/updated files
            downloaded_size = 0
            for i, file_info in enumerate(files_to_download, 1):
                success = self._download_file(file_info)
                if success:
                    downloaded_size += file_info['size']
                    progress = (i / len(files_to_download)) * 100
                    print(f"进度: {i}/{len(files_to_download)} ({progress:.1f}%) - "
                          f"{self._format_size(downloaded_size)}/{self._format_size(total_size)}")
                else:
                    print(f"下载失败: {file_info['path']}")

            print("增量同步完成")
            return True

        except Exception as e:
            print(f"增量同步失败: {e}")
            return False

    def sync(self, prefer_zip=True, backup=True):
        """
        Synchronize data with automatic fallback

        Args:
            prefer_zip (bool): Try ZIP sync first, fallback to incremental
            backup (bool): Whether to backup existing data for ZIP sync

        Returns:
            bool: Success status
        """
        print("开始数据同步...")

        # Check server health first
        if not self.check_server_health():
            return False

        # Get server info
        server_info = self.get_server_info()
        if server_info:
            print(f"服务器信息:")
            print(f"  文件数量: {server_info.get('server_info', {}).get('file_count', 0)}")
            print(f"  总大小: {self._format_size(server_info.get('server_info', {}).get('total_size', 0))}")

        if prefer_zip:
            # Try ZIP sync first
            print("尝试 ZIP 全量同步...")
            if self.sync_full_zip(backup=backup):
                return True
            else:
                print("ZIP 同步失败，尝试增量同步...")
                return self.sync_incremental()
        else:
            # Try incremental sync first
            print("尝试增量同步...")
            if self.sync_incremental():
                return True
            else:
                print("增量同步失败，尝试 ZIP 同步...")
                return self.sync_full_zip(backup=backup)

    def _download_file(self, file_info):
        """Download single file from server"""
        try:
            response = self._request('file', params={'path': file_info['path']}, stream=True)

            # Ensure directory exists
            file_path = os.path.join(self.data_path, file_info['path'])
            os.makedirs(os.path.dirname(file_path), exist_ok=True)

            # Save file
            with open(file_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)

            # Set modification time to match remote
            os.utime(file_path, (file_info['mtime'], file_info['mtime']))
            return True

        except Exception as e:
            print(f"下载文件失败 {file_info['path']}: {e}")
            return False

    def _backup_existing_data(self):
        """Backup existing data directory"""
        if not os.path.exists(self.data_path) or not os.listdir(self.data_path):
            print("本地数据目录为空，无需备份")
            return True

        # 创建备份目录在启动器运行路径下
        launcher_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        backup_dir = os.path.join(launcher_dir, "backup")
        os.makedirs(backup_dir, exist_ok=True)

        # 使用数据目录的相对路径作为备份文件夹名
        data_dir_name = os.path.basename(self.data_path.rstrip('/\\'))
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        backup_path = os.path.join(backup_dir, f"{data_dir_name}_{timestamp}")

        try:
            print(f"备份现有数据到: {backup_path}")
            shutil.copytree(self.data_path, backup_path)

            # Store backup path for potential restore
            self._last_backup_path = backup_path
            return True

        except Exception as e:
            print(f"备份失败: {e}")
            return False

    def _restore_backup(self):
        """Restore data from last backup"""
        if not hasattr(self, '_last_backup_path'):
            print("没有找到备份文件")
            return False

        backup_path = self._last_backup_path
        if not os.path.exists(backup_path):
            print("备份文件不存在")
            return False

        try:
            print(f"从备份恢复: {backup_path}")

            # Remove current data
            if os.path.exists(self.data_path):
                shutil.rmtree(self.data_path)

            # Restore backup
            shutil.copytree(backup_path, self.data_path)
            print("数据恢复完成")
            return True

        except Exception as e:
            print(f"恢复备份失败: {e}")
            return False

    def _extract_zip_with_progress(self, zip_path, extract_path):
        """Extract ZIP file with progress reporting"""
        with zipfile.ZipFile(zip_path, 'r') as zip_file:
            files = zip_file.namelist()
            total_files = len(files)

            for i, file in enumerate(files, 1):
                # Skip directories
                if file.endswith('/'):
                    continue

                # Extract file
                zip_file.extract(file, extract_path)

                # Show progress for large archives
                if total_files > 10 and i % max(1, total_files // 10) == 0:
                    progress = (i / total_files) * 100
                    print(f"解压进度: {i}/{total_files} ({progress:.1f}%)")

    def _format_size(self, size_bytes):
        """Format file size in human readable format"""
        if size_bytes == 0:
            return "0B"

        size_names = ["B", "KB", "MB", "GB"]
        i = 0
        while size_bytes >= 1024 and i < len(size_names) - 1:
            size_bytes /= 1024.0
            i += 1

        return f"{size_bytes:.1f}{size_names[i]}"


def main():
    """Main function for standalone client"""
    parser = argparse.ArgumentParser(description='SillyTavern 数据同步客户端')
    parser.add_argument('server_url', help='服务器地址 (例如: http://192.168.1.100:9999)')
    parser.add_argument('--data-path', '-d', help='本地数据目录路径 (默认自动检测)')
    parser.add_argument('--method', '-m', choices=['zip', 'incremental', 'auto'],
                       default='auto', help='同步方法 (默认: auto)')
    parser.add_argument('--no-backup', action='store_true', help='ZIP同步时不备份现有数据')
    parser.add_argument('--timeout', '-t', type=int, default=30, help='请求超时时间 (秒)')

    args = parser.parse_args()

    try:
        client = SyncClient(args.server_url, args.data_path, args.timeout)

        # Choose sync method
        prefer_zip = args.method in ['zip', 'auto']
        backup = not args.no_backup

        if args.method == 'incremental':
            success = client.sync_incremental()
        elif args.method == 'zip':
            success = client.sync_full_zip(backup=backup)
        else:  # auto
            success = client.sync(prefer_zip=prefer_zip, backup=backup)

        if success:
            print("同步完成!")
            return 0
        else:
            print("同步失败!")
            return 1

    except Exception as e:
        print(f"同步过程中发生错误: {e}")
        return 1


if __name__ == "__main__":
    exit(main())