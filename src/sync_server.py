#!/usr/bin/env python3
"""
SillyTavern Data Sync Server
Flask HTTP service for providing SillyTavern user data to clients
"""

import os
import json
import zipfile
import io
import hashlib
from datetime import datetime
from pathlib import Path
from flask import Flask, request, jsonify, send_file, Response
import threading
import time


class SyncServer:
    def __init__(self, data_path=None, port=9999, host='0.0.0.0'):
        """
        Initialize sync server

        Args:
            data_path (str): Path to SillyTavern data directory
            port (int): Server port
            host (str): Server host address
        """
        self.app = Flask(__name__)
        self.port = port
        self.host = host
        self.data_path = data_path or self._find_data_path()
        self.running = False
        self.server_thread = None

        # Validate data path
        if not os.path.exists(self.data_path):
            raise FileNotFoundError(f"数据目录不存在: {self.data_path}")

        print(f"数据同步服务已初始化")
        print(f"数据路径: {self.data_path}")
        print(f"监听地址: {host}:{port}")

        self._setup_routes()

    def _find_data_path(self):
        """Auto-detect SillyTavern data path"""
        # Common SillyTavern data locations
        possible_paths = [
            os.path.join(os.getcwd(), "SillyTavern", "data", "default-user"),
            os.path.join(os.getcwd(), "data", "default-user"),
            os.path.expanduser("~/SillyTavern/data/default-user"),
            "./SillyTavern/data/default-user"
        ]

        for path in possible_paths:
            if os.path.exists(path):
                print(f"自动检测到数据目录: {path}")
                return path

        # Fallback to current directory structure
        default_path = os.path.join(os.getcwd(), "SillyTavern", "data", "default-user")
        print(f"未找到数据目录，使用默认路径: {default_path}")
        return default_path

    def _setup_routes(self):
        """Setup Flask routes"""

        @self.app.route('/health', methods=['GET'])
        def health_check():
            """Health check endpoint"""
            return jsonify({
                'status': 'healthy',
                'timestamp': datetime.now().isoformat(),
                'data_path': self.data_path
            })

        @self.app.route('/manifest', methods=['GET'])
        def get_manifest():
            """Get file manifest with metadata"""
            try:
                manifest = self._generate_manifest()
                return jsonify({
                    'success': True,
                    'manifest': manifest,
                    'total_files': len(manifest),
                    'generated_at': datetime.now().isoformat()
                })
            except Exception as e:
                return jsonify({
                    'success': False,
                    'error': str(e)
                }), 500

        @self.app.route('/zip', methods=['GET'])
        def get_zip():
            """Get all data as ZIP file"""
            try:
                zip_buffer = self._create_zip()
                return send_file(
                    io.BytesIO(zip_buffer.getvalue()),
                    mimetype='application/zip',
                    as_attachment=False,
                    download_name='sillytavern_data.zip'
                )
            except Exception as e:
                return jsonify({
                    'success': False,
                    'error': str(e)
                }), 500

        @self.app.route('/file', methods=['GET'])
        def get_file():
            """Get specific file"""
            file_path = request.args.get('path')
            if not file_path:
                return jsonify({
                    'success': False,
                    'error': 'Missing path parameter'
                }), 400

            try:
                # Security check - prevent directory traversal
                file_path = os.path.normpath(file_path).replace('..', '')
                full_path = os.path.join(self.data_path, file_path)

                if not os.path.exists(full_path):
                    return jsonify({
                        'success': False,
                        'error': f'File not found: {file_path}'
                    }), 404

                if not os.path.isfile(full_path):
                    return jsonify({
                        'success': False,
                        'error': f'Not a file: {file_path}'
                    }), 400

                return send_file(
                    full_path,
                    as_attachment=False,
                    download_name=os.path.basename(full_path)
                )

            except Exception as e:
                return jsonify({
                    'success': False,
                    'error': str(e)
                }), 500

        @self.app.route('/info', methods=['GET'])
        def get_info():
            """Get server information"""
            return jsonify({
                'success': True,
                'server_info': {
                    'data_path': self.data_path,
                    'port': self.port,
                    'host': self.host,
                    'running': self.running,
                    'total_size': self._calculate_total_size(),
                    'file_count': len(self._generate_manifest())
                }
            })

    def _generate_manifest(self):
        """Generate file manifest with metadata"""
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

    def _create_zip(self):
        """Create ZIP file of all data"""
        zip_buffer = io.BytesIO()

        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
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
                        zip_file.write(file_path, relative_path)
                    except OSError:
                        # Skip files that can't be accessed
                        continue

        zip_buffer.seek(0)
        return zip_buffer

    def _calculate_total_size(self):
        """Calculate total size of data directory"""
        total_size = 0
        for root, dirs, files in os.walk(self.data_path):
            for file in files:
                file_path = os.path.join(root, file)
                try:
                    total_size += os.path.getsize(file_path)
                except OSError:
                    continue
        return total_size

    def start(self, block=False):
        """Start the sync server"""
        if self.running:
            print("数据同步服务已在运行")
            return

        def run_server():
            print(f"启动数据同步服务...")
            self.app.run(host=self.host, port=self.port, debug=False)

        if block:
            self.running = True
            run_server()
        else:
            self.server_thread = threading.Thread(target=run_server, daemon=True)
            self.server_thread.start()
            self.running = True
            print(f"数据同步服务已启动在后台: http://{self.host}:{self.port}")
            print("可用接口:")
            print("  GET /health      - 健康检查")
            print("  GET /manifest    - 获取文件清单")
            print("  GET /zip         - 下载所有数据(ZIP)")
            print("  GET /file?path=  - 下载指定文件")
            print("  GET /info        - 服务器信息")

    def stop(self):
        """Stop the sync server"""
        if self.running:
            self.running = False
            print("数据同步服务已停止")


def main():
    """Main function for standalone server"""
    import argparse

    parser = argparse.ArgumentParser(description='SillyTavern 数据同步服务器')
    parser.add_argument('--data-path', '-d',
                       help='SillyTavern数据目录路径 (默认自动检测)')
    parser.add_argument('--port', '-p', type=int, default=9999,
                       help='服务器端口 (默认: 9999)')
    parser.add_argument('--host', default='0.0.0.0',
                       help='服务器主机地址 (默认: 0.0.0.0)')
    parser.add_argument('--block', action='store_true',
                       help='阻塞运行 (默认后台运行)')

    args = parser.parse_args()

    try:
        server = SyncServer(data_path=args.data_path, port=args.port, host=args.host)
        server.start(block=args.block)

        if not args.block:
            print("按 Ctrl+C 停止服务...")
            try:
                while server.running:
                    time.sleep(1)
            except KeyboardInterrupt:
                print("\n正在停止服务...")
                server.stop()

    except Exception as e:
        print(f"启动服务器失败: {e}")
        return 1

    return 0


if __name__ == "__main__":
    exit(main())