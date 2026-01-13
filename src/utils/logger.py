"""
统一日志系统
- 使用 logging 模块作为主要日志工具
- 降级到 print 作为后备
- 所有异常必须记录，不再静默吞噬
"""

import logging
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
        """只初始化一次，防止重复添加 handler"""
        if self._initialized:
            return
        self.logger = logging.getLogger(name)
        self._setup_logger()
        self._initialized = True

    def _setup_logger(self):
        try:
            # 检查是否已配置 handler，防止重复添加
            if self.logger.handlers:
                return

            # 配置日志格式
            formatter = logging.Formatter(
                '[%(levelname)s] %(name)s - %(message)s'
            )

            # 控制台处理器
            console_handler = logging.StreamHandler(sys.stdout)
            console_handler.setFormatter(formatter)
            self.logger.addHandler(console_handler)

            # 文件处理器（可选）
            try:
                file_handler = logging.FileHandler('app.log', encoding='utf-8')
                file_handler.setFormatter(formatter)
                self.logger.addHandler(file_handler)
            except Exception:
                pass  # 文件日志失败不影响控制台日志

            self.logger.setLevel(logging.INFO)
        except Exception as e:
            # logging 配置失败，使用 print 后备
            print(f"[WARNING] 日志系统初始化失败: {e}")

    def info(self, msg: str):
        try:
            self.logger.info(msg)
        except Exception:
            print(f"[INFO] {msg}")

    def warning(self, msg: str):
        try:
            self.logger.warning(msg)
        except Exception:
            print(f"[WARNING] {msg}")

    def error(self, msg: str, exc_info: bool = False):
        try:
            self.logger.error(msg, exc_info=exc_info)
        except Exception:
            print(f"[ERROR] {msg}")

    def exception(self, msg: str):
        """记录异常，包含堆栈跟踪"""
        try:
            self.logger.exception(msg)
        except Exception:
            print(f"[EXCEPTION] {msg}")
            import traceback
            traceback.print_exc()

    def debug(self, msg: str):
        """记录调试信息"""
        try:
            self.logger.debug(msg)
        except Exception:
            print(f"[DEBUG] {msg}")


# 全局实例
app_logger = AppLogger()
