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
import logging
from werkzeug.serving import WSGIRequestHandler


class UILogHandler(logging.Handler):
    """Custom log handler to redirect Flask logs to UI log system"""

    def __init__(self, ui_log_callback):
        super().__init__()
        self.ui_log_callback = ui_log_callback
        self.setFormatter(logging.Formatter('%(message)s'))

    def emit(self, record):
        """Emit a log record to the UI log system"""
        try:
            message = self.format(record)

            # Filter out Flask debug messages we don't want to show
            if any(skip in message for skip in [
                " * Debugger is active!",
                " * Debugger PIN:",
                " * Running on http://",
                "WARNING: This is a development server.",
                "Use a production WSGI server instead.",
                "Press CTRL+C to quit"
            ]):
                return

            # Process HTTP access logs (format: IP - - [timestamp] "METHOD path" status)
            if ' - - [' in message and '] "' in message:
                # This looks like an HTTP access log
                self.ui_log_callback(message, 'info')
                return

            # Determine log level
            if record.levelno >= logging.ERROR:
                level = 'error'
            elif record.levelno >= logging.WARNING:
                level = 'warning'
            else:
                level = 'info'

            # Send to UI log system
            self.ui_log_callback(message, level)
        except Exception:
            # If UI callback fails, don't break the logging
            pass


class CustomRequestHandler(WSGIRequestHandler):
    """Custom request handler to format access logs for UI"""

    def log_request(self, code='-', size='-'):
        """Override log_request to create custom HTTP access log format"""
        try:
            # Get the UI callback from the server instance
            if hasattr(self.server.app, 'ui_log_callback'):
                ui_log_callback = self.server.app.ui_log_callback
                if ui_log_callback:
                    # Create custom HTTP access log format
                    client_ip = self.client_address[0] if self.client_address else '-'
                    method = self.command if hasattr(self, 'command') else '-'
                    path = self.path if hasattr(self, 'path') else '/'
                    user_agent = self.headers.get('User-Agent', '-') if hasattr(self, 'headers') else '-'
                    referer = self.headers.get('Referer', '-') if hasattr(self, 'headers') else '-'

                    # Format: IP - - [timestamp] "METHOD path" status "User-Agent" "Referer"
                    from datetime import datetime
                    timestamp = datetime.now().strftime('%d/%b/%Y %H:%M:%S')

                    log_message = f'{client_ip} - - [{timestamp}] "{method} {path}" {code} "{user_agent}" "{referer}"'

                    # Remove ANSI escape codes if any
                    import re
                    clean_message = re.sub(r'\x1b\[[0-9;]*m', '', log_message)
                    ui_log_callback(f"HTTP请求: {clean_message}", 'info')
                    return
        except Exception:
            pass

        # Fallback to default logging
        super().log_request(code, size)

    def log(self, type, message, *args):
        """Override log method to redirect to UI log system"""
        try:
            # Get the UI callback from the server instance
            if hasattr(self.server.app, 'ui_log_callback'):
                ui_log_callback = self.server.app.ui_log_callback
                if ui_log_callback:
                    # Format the access log message
                    formatted_message = message % args
                    # Remove ANSI escape codes if any
                    import re
                    clean_message = re.sub(r'\x1b\[[0-9;]*m', '', formatted_message)
                    ui_log_callback(f"服务器日志: {clean_message}", 'info')
                    return
        except Exception:
            pass

        # Fallback to default logging
        super().log(type, message, *args)


class SyncServer:
    def __init__(self, data_path=None, port=9999, host=None):
        """
        Initialize sync server

        Args:
            data_path (str): Path to SillyTavern data directory
            port (int): Server port
            host (str): Server host address
        """
        self.app = Flask(__name__)
        self.port = port
        # 如果没有指定host，则自动获取局域网IP，确保只在局域网内工作
        if host is None:
            self.host = self._get_lan_ip() or "192.168.1.100"
        else:
            self.host = host
        self.data_path = data_path or self._find_data_path()
        self.running = False
        self.server_thread = None
        self.httpd = None  # Werkzeug HTTP 服务器引用，用于优雅关闭

        # UI callback for log messages
        self._ui_log_callback = None

        # Validate data path
        if not os.path.exists(self.data_path):
            raise FileNotFoundError(f"数据目录不存在: {self.data_path}")

        self._log(f"数据同步服务已初始化", 'info')
        self._log(f"数据路径: {self.data_path}", 'info')
        self._log(f"监听地址: {self.host}:{port}", 'info')
        self._log("注意: 服务器仅在局域网内监听，确保安全性", 'info')

        # Store UI log callback in Flask app for request handler access
        # This will be updated when set_ui_log_callback is called
        self.app.ui_log_callback = None

        # Setup logging and custom request handler
        self._setup_logging()
        self._setup_routes()

    def set_ui_log_callback(self, callback):
        """
        Set UI callback for log messages

        Args:
            callback: Function to call with log messages (message, level)
        """
        self._ui_log_callback = callback
        # Also update the Flask app's callback for request handler access
        self.app.ui_log_callback = callback

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

    def _setup_logging(self):
        """Setup custom logging to redirect Flask logs to UI"""
        if self._ui_log_callback:
            # Add custom log handler to Flask app logger
            ui_handler = UILogHandler(self._ui_log_callback)
            ui_handler.setLevel(logging.INFO)

            # Capture logs from all relevant loggers
            loggers_to_configure = [
                'werkzeug',          # Flask/Werkzeug server logs
                'flask.app',          # Flask application logs
                'flask',              # General Flask logs
                '__main__',            # Main module logs
            ]

            for logger_name in loggers_to_configure:
                logger = logging.getLogger(logger_name)
                logger.addHandler(ui_handler)
                logger.setLevel(logging.INFO)
                # Prevent propagation to avoid duplicate logs
                logger.propagate = False

    def _get_lan_ip(self):
        """
        获取本机局域网IP地址

        Returns:
            str: 本机局域网IP地址，如果获取失败则返回None
        """
        import socket
        import subprocess

        try:
            # 方法1: 尝试连接外部DNS获取IP
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(3)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()

            # 验证是否为有效的局域网IP
            if self._is_lan_ip(local_ip):
                return local_ip

        except Exception:
            pass

        try:
            # 方法2: 使用ipconfig命令
            result = subprocess.run(['ipconfig'], capture_output=True, text=True, shell=True)
            if result.returncode == 0:
                import re
                # 查找IPv4地址
                ipv4_pattern = r'IPv4 地址[\. ]+\: ([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})'
                ips = re.findall(ipv4_pattern, result.stdout)

                for ip in ips:
                    if self._is_lan_ip(ip):
                        return ip

        except Exception:
            pass

        return None

    def _is_lan_ip(self, ip):
        """
        验证是否为局域网IP地址

        Args:
            ip (str): 要验证的IP地址

        Returns:
            bool: 是否为局域网IP地址
        """
        try:
            parts = ip.split('.')
            if len(parts) != 4:
                return False

            # 排除特殊地址
            if ip.startswith("127.") or ip.startswith("169.254."):
                return False

            first_octet = int(parts[0])
            second_octet = int(parts[1])

            # 私有IP地址范围：
            # 10.0.0.0 - 10.255.255.255 (Class A)
            # 172.16.0.0 - 172.31.255.255 (Class B)
            # 192.168.0.0 - 192.168.255.255 (Class C)
            return (first_octet == 10) or \
                   (first_octet == 172 and 16 <= second_octet <= 31) or \
                   (first_octet == 192 and second_octet == 168)

        except (ValueError, AttributeError, IndexError):
            return False

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
            self._log("数据同步服务已在运行", 'warning')
            return

        def run_server():
            self._log(f"启动数据同步服务...", 'info')

            # Configure Flask to show access logs
            import logging
            werkzeug_logger = logging.getLogger('werkzeug')
            werkzeug_logger.setLevel(logging.INFO)

            # Start Flask server with custom request handler for better access logging
            from werkzeug.serving import make_server
            self.httpd = make_server(self.host, self.port, self.app, request_handler=CustomRequestHandler)
            self.httpd.serve_forever()

        if block:
            self.running = True
            run_server()
        else:
            self.server_thread = threading.Thread(target=run_server, daemon=False)
            self.server_thread.start()
            self.running = True
            self._log(f"数据同步服务已启动在后台: http://{self.host}:{self.port}", 'success')
            self._log("可用接口:", 'info')
            self._log("  GET /health      - 健康检查", 'info')
            self._log("  GET /manifest    - 获取文件清单", 'info')
            self._log("  GET /zip         - 下载所有数据(ZIP)", 'info')
            self._log("  GET /file?path=  - 下载指定文件", 'info')
            self._log("  GET /info        - 服务器信息", 'info')

    def stop(self):
        """Stop the sync server"""
        if self.running:
            self.running = False

            # 优雅关闭 HTTP 服务器
            if hasattr(self, 'httpd') and self.httpd:
                self.httpd.shutdown()

                # 等待服务器线程结束
                if hasattr(self, 'server_thread') and self.server_thread:
                    if self.server_thread.is_alive():
                        self.server_thread.join(timeout=5.0)

            self._log("数据同步服务已停止", 'info')


def main():
    """Main function for standalone server"""
    import argparse

    parser = argparse.ArgumentParser(description='SillyTavern 数据同步服务器')
    parser.add_argument('--data-path', '-d',
                       help='SillyTavern数据目录路径 (默认自动检测)')
    parser.add_argument('--port', '-p', type=int, default=9999,
                       help='服务器端口 (默认: 9999)')
    parser.add_argument('--host', default=None,
                       help='服务器主机地址 (默认: 自动检测局域网IP)')
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