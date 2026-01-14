"""
统一日志系统
- 使用 logging 模块作为主要日志工具
- 降级到 print 作为后备
- 所有异常必须记录，不再静默吞噬
"""

import logging
import os
import sys
import threading
from typing import Optional


class AppLogger:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls, name: str = "SillyTavernLauncher"):
        """实现单例模式，防止重复创建实例"""
        if cls._instance is None:
            with cls._lock:
                # 双重检查锁定
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self, name: str = "SillyTavernLauncher"):
        """只初始化一次，防止重复添加 handler

        支持环境变量配置：
        - LOG_LEVEL: 日志级别 (DEBUG, INFO, WARNING, ERROR, CRITICAL)，默认 INFO
        """
        if self._initialized:
            return
        self.logger = logging.getLogger(name)

        # 从环境变量读取日志级别，默认 INFO
        log_level = os.getenv('LOG_LEVEL', 'INFO')
        self._setup_logger(log_level)
        self._initialized = True

    def _setup_logger(self, log_level: str = 'INFO'):
        """配置日志系统

        Args:
            log_level: 日志级别字符串 (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        """
        try:
            # 检查是否已配置 handler，防止重复添加
            if self.logger.handlers:
                return

            # 配置日志格式（包含时间戳）
            formatter = logging.Formatter(
                '[%(asctime)s] [%(levelname)s] %(name)s - %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )

            # 控制台处理器
            console_handler = logging.StreamHandler(sys.stdout)
            console_handler.setFormatter(formatter)
            self.logger.addHandler(console_handler)

            # 文件处理器（可选）
            try:
                # 创建 logs 文件夹
                logs_dir = os.path.join(os.getcwd(), "logs")
                os.makedirs(logs_dir, exist_ok=True)

                # 使用 app_时间.txt 格式
                from datetime import datetime
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                log_file_path = os.path.join(logs_dir, f"app_{timestamp}.txt")

                file_handler = logging.FileHandler(log_file_path, encoding='utf-8')
                file_handler.setFormatter(formatter)
                self.logger.addHandler(file_handler)
            except Exception:
                pass  # 文件日志失败不影响控制台日志

            # 设置日志级别（支持环境变量配置）
            level = getattr(logging, log_level.upper(), logging.INFO)
            self.logger.setLevel(level)
        except Exception as e:
            # logging 配置失败，使用 print 后备
            print(f"[WARNING] 日志系统初始化失败: {e}")

    def _get_timestamp(self):
        """获取当前时间戳字符串"""
        from datetime import datetime
        return datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    def info(self, msg: str):
        try:
            self.logger.info(msg)
        except Exception:
            print(f"[{self._get_timestamp()}] [INFO] {msg}")

    def warning(self, msg: str):
        try:
            self.logger.warning(msg)
        except Exception:
            print(f"[{self._get_timestamp()}] [WARNING] {msg}")

    def error(self, msg: str, exc_info: bool = False):
        try:
            self.logger.error(msg, exc_info=exc_info)
        except Exception:
            print(f"[{self._get_timestamp()}] [ERROR] {msg}")

    def exception(self, msg: str):
        """记录异常，包含堆栈跟踪"""
        try:
            self.logger.exception(msg)
        except Exception:
            print(f"[{self._get_timestamp()}] [EXCEPTION] {msg}")
            import traceback
            traceback.print_exc()

    def debug(self, msg: str):
        """记录调试信息"""
        try:
            self.logger.debug(msg)
        except Exception:
            print(f"[{self._get_timestamp()}] [DEBUG] {msg}")

    def critical(self, msg: str):
        """记录严重错误"""
        try:
            self.logger.critical(msg)
        except Exception:
            print(f"[{self._get_timestamp()}] [CRITICAL] {msg}")


# 全局实例
app_logger = AppLogger()
