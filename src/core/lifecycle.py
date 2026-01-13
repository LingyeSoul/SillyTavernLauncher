"""
统一生命周期管理器
- 定义资源清理顺序和依赖关系
- 确保每个资源只清理一次
- 防止竞态条件
"""

import threading
from typing import Callable, Optional, Set, Dict, Any, List
from enum import Enum, auto


class ResourceState(Enum):
    """资源状态"""
    INITIALIZED = auto()
    CLEANING = auto()
    CLEANED = auto()


class ResourceType(Enum):
    """资源类型，定义清理顺序（数字越小越先清理）"""
    SYNC_UI = 1          # 最先清理：销毁同步UI
    TERMINAL_PROCESSES = 2  # 停止终端进程
    SYNC_SERVER = 3      # 停止同步服务器
    TRAY = 4             # 停止托盘
    UI_EVENT = 5         # 清理UI事件
    TERMINAL = 6         # 清理终端资源
    UNI_UI = 7           # 最后清理：主UI对象


class LifecycleManager:
    def __init__(self):
        self._resources: Dict[ResourceType, Any] = {}
        self._states: Dict[ResourceType, ResourceState] = {}
        self._cleanup_lock = threading.Lock()
        self._cleaned_resources: Set[ResourceType] = set()
        self._cleanup_stack: List[ResourceType] = []  # 用于跟踪递归清理

    def register(self, resource_type: ResourceType, resource: Any):
        """注册资源"""
        if resource is not None:
            self._resources[resource_type] = resource
            self._states[resource_type] = ResourceState.INITIALIZED

    def mark_cleaned(self, resource_type: ResourceType):
        """标记资源已清理"""
        with self._cleanup_lock:
            self._cleaned_resources.add(resource_type)
            self._states[resource_type] = ResourceState.CLEANED

    def is_cleaned(self, resource_type: ResourceType) -> bool:
        """检查资源是否已清理"""
        return resource_type in self._cleaned_resources

    def get_resource(self, resource_type: ResourceType) -> Optional[Any]:
        """获取资源，如果已清理则返回 None"""
        if self.is_cleaned(resource_type):
            return None
        return self._resources.get(resource_type)

    def cleanup(self, resource_type: ResourceType, cleanup_func: Callable):
        """
        清理指定资源
        - 确保只清理一次
        - 记录所有异常
        - 使用栈检测递归，防止死锁
        """
        with self._cleanup_lock:
            # 检查是否已清理
            if resource_type in self._cleaned_resources:
                return  # 已经清理过，跳过

            # 使用栈检测递归（而不是全局标志）
            if resource_type in self._cleanup_stack:
                # 检测到递归清理，跳过以防止无限循环
                print(f"[WARNING] 检测到递归清理: {resource_type.name}")
                return

            # 获取资源引用
            resource = self._resources.get(resource_type)
            if resource is None:
                self._cleaned_resources.add(resource_type)
                return

            # 标记为清理中，并加入栈
            self._cleanup_stack.append(resource_type)
            self._states[resource_type] = ResourceState.CLEANING

        # 释放锁后执行清理函数（避免死锁）
        try:
            from utils.logger import app_logger
            app_logger.info(f"清理资源: {resource_type.name}")
            cleanup_func(resource)
        except Exception as e:
            from utils.logger import app_logger
            app_logger.exception(f"清理资源 {resource_type.name} 时出错")
        finally:
            # 重新获取锁，更新状态
            with self._cleanup_lock:
                self._cleanup_stack.remove(resource_type)
                self._cleaned_resources.add(resource_type)
                self._states[resource_type] = ResourceState.CLEANED

    def cleanup_all(self, cleanup_map: Dict[ResourceType, Callable]):
        """
        按顺序清理所有资源
        cleanup_map: 资源类型到清理函数的映射
        """
        with self._cleanup_lock:
            # 检查是否已在清理中（栈不为空说明正在清理）
            if self._cleanup_stack:
                return  # 已经在清理中，跳过

        try:
            from utils.logger import app_logger
            app_logger.info("开始清理所有资源...")

            # 按 ResourceType 定义的顺序清理
            for resource_type in sorted(cleanup_map.keys(), key=lambda x: x.value):
                cleanup_func = cleanup_map[resource_type]
                self.cleanup(resource_type, cleanup_func)

            app_logger.info("所有资源清理完成")
        except Exception as e:
            from utils.logger import app_logger
            app_logger.exception("清理所有资源时出错")


# 全局实例
lifecycle_manager = LifecycleManager()
