"""
扩展管理器模块

提供 SillyTavern 扩展的管理功能，包括：
- 全局插件管理 (SillyTavern/public/scripts/extensions/third-party)
- 用户插件管理 (SillyTavern/data/default-user/extensions)
- Git 安装插件（支持镜像源）
- ZIP 安装插件
- 插件互相转换
"""

import os
import shutil
import subprocess
import zipfile
import json
import re
from typing import Tuple, List, Callable
from dataclasses import dataclass, field
from enum import Enum
import threading

from config.config_manager import ConfigManager
from core.git_utils import _get_git_command, _format_git_cmd
from utils.logger import app_logger
from typing import Optional, Tuple, List, Dict, Callable
from dataclasses import dataclass, field
from enum import Enum
import threading

from config.config_manager import ConfigManager
from core.git_utils import _get_git_command, _format_git_cmd
from utils.logger import app_logger


class ExtensionType(Enum):
    """扩展类型"""

    GLOBAL = "global"  # 全局插件
    USER = "user"  # 用户插件


@dataclass
class ExtensionInfo:
    """扩展信息数据类"""

    name: str
    path: str
    ext_type: ExtensionType
    manifest: Optional[Dict] = field(default=None)
    is_valid: bool = field(default=True)
    error_msg: str = field(default="")

    @property
    def display_name(self) -> str:
        """获取显示名称"""
        if self.manifest and "display_name" in self.manifest:
            return self.manifest["display_name"]
        return self.name

    @property
    def version(self) -> str:
        """获取版本号"""
        if self.manifest and "version" in self.manifest:
            return self.manifest["version"]
        return "未知"

    @property
    def description(self) -> str:
        """获取描述"""
        if self.manifest and "description" in self.manifest:
            return self.manifest["description"]
        return ""

    @property
    def author(self) -> str:
        """获取作者"""
        if self.manifest and "author" in self.manifest:
            return self.manifest["author"]
        return "未知"


class ExtensionManager:
    """扩展管理器类"""

    # 目录路径
    GLOBAL_EXT_DIR = "SillyTavern/public/scripts/extensions/third-party"
    USER_EXT_DIR = "SillyTavern/data/default-user/extensions"

    def __init__(self, log_callback: Optional[Callable[[str], None]] = None):
        """
        初始化扩展管理器

        Args:
            log_callback: 日志回调函数，用于向UI输出日志
        """
        self.config_manager = ConfigManager()
        self.log_callback = log_callback
        self._lock = threading.Lock()

    def _log(self, message: str):
        """输出日志"""
        app_logger.info(message)
        if self.log_callback:
            self.log_callback(message)

    def _get_base_path(self) -> str:
        """获取基础路径"""
        return os.getcwd()

    def _get_global_ext_path(self) -> str:
        """获取全局扩展目录路径"""
        return os.path.join(self._get_base_path(), self.GLOBAL_EXT_DIR)

    def _get_user_ext_path(self) -> str:
        """获取用户扩展目录路径"""
        return os.path.join(self._get_base_path(), self.USER_EXT_DIR)

    def _ensure_dir_exists(self, path: str):
        """确保目录存在"""
        if not os.path.exists(path):
            os.makedirs(path, exist_ok=True)
            self._log(f"创建目录: {path}")

    def _load_manifest(self, ext_path: str) -> Optional[Dict]:
        """
        加载扩展的 manifest.json 文件

        Args:
            ext_path: 扩展目录路径

        Returns:
            manifest 字典，如果不存在则返回 None
        """
        manifest_path = os.path.join(ext_path, "manifest.json")
        if os.path.exists(manifest_path):
            try:
                with open(manifest_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                app_logger.warning(f"加载 manifest 失败 {manifest_path}: {e}")
        return None

    def _is_valid_extension(self, ext_path: str) -> bool:
        """
        检查目录是否是有效的扩展

        Args:
            ext_path: 扩展目录路径

        Returns:
            是否是有效的扩展
        """
        if not os.path.isdir(ext_path):
            return False

        # 检查是否有 manifest.json 或 index.js
        manifest_exists = os.path.exists(os.path.join(ext_path, "manifest.json"))
        index_exists = os.path.exists(os.path.join(ext_path, "index.js"))

        return manifest_exists or index_exists

    def scan_extensions(self, ext_type: ExtensionType) -> List[ExtensionInfo]:
        """
        扫描指定类型的扩展

        Args:
            ext_type: 扩展类型

        Returns:
            扩展信息列表
        """
        extensions = []

        if ext_type == ExtensionType.GLOBAL:
            base_path = self._get_global_ext_path()
        else:
            base_path = self._get_user_ext_path()

        self._ensure_dir_exists(base_path)

        try:
            for item in os.listdir(base_path):
                item_path = os.path.join(base_path, item)
                if os.path.isdir(item_path) and not item.startswith("."):
                    if self._is_valid_extension(item_path):
                        manifest = self._load_manifest(item_path)
                        ext_info = ExtensionInfo(
                            name=item,
                            path=item_path,
                            ext_type=ext_type,
                            manifest=manifest,
                            is_valid=True,
                        )
                        extensions.append(ext_info)
                    else:
                        # 无效扩展但仍然显示
                        ext_info = ExtensionInfo(
                            name=item,
                            path=item_path,
                            ext_type=ext_type,
                            is_valid=False,
                            error_msg="缺少 manifest.json 或 index.js",
                        )
                        extensions.append(ext_info)
        except Exception as e:
            self._log(f"扫描扩展失败: {e}")
            app_logger.error(f"扫描扩展失败: {e}", exc_info=True)

        # 按名称排序
        extensions.sort(key=lambda x: x.name.lower())
        return extensions

    def get_all_extensions(self) -> Dict[ExtensionType, List[ExtensionInfo]]:
        """
        获取所有扩展

        Returns:
            按类型分类的扩展字典
        """
        return {
            ExtensionType.GLOBAL: self.scan_extensions(ExtensionType.GLOBAL),
            ExtensionType.USER: self.scan_extensions(ExtensionType.USER),
        }

    def delete_extension(self, ext_info: ExtensionInfo) -> Tuple[bool, str]:
        """
        删除扩展

        Args:
            ext_info: 扩展信息

        Returns:
            (成功, 消息)
        """
        try:
            if os.path.exists(ext_info.path):
                # Windows 上需要处理只读文件
                def on_rm_error(func, path, exc_info):
                    """处理删除只读文件的错误"""
                    import stat
                    os.chmod(path, stat.S_IWRITE)
                    func(path)
                
                shutil.rmtree(ext_info.path, onerror=on_rm_error)
                self._log(f"已删除扩展: {ext_info.name}")
                return True, f"成功删除扩展: {ext_info.name}"
            else:
                return False, f"扩展目录不存在: {ext_info.path}"
            if os.path.exists(ext_info.path):
                shutil.rmtree(ext_info.path)
                self._log(f"已删除扩展: {ext_info.name}")
                return True, f"成功删除扩展: {ext_info.name}"
            else:
                return False, f"扩展目录不存在: {ext_info.path}"
        except Exception as e:
            error_msg = f"删除扩展失败: {e}"
            app_logger.error(error_msg, exc_info=True)
            return False, error_msg

    def move_extension(
        self, ext_info: ExtensionInfo, target_type: ExtensionType
    ) -> Tuple[bool, str]:
        """
        移动扩展到另一类型（全局/用户互转）

        Args:
            ext_info: 扩展信息
            target_type: 目标类型

        Returns:
            (成功, 消息)
        """
        if ext_info.ext_type == target_type:
            return False, "源类型和目标类型相同"

        # 确定目标路径
        if target_type == ExtensionType.GLOBAL:
            target_dir = self._get_global_ext_path()
        else:
            target_dir = self._get_user_ext_path()

        self._ensure_dir_exists(target_dir)
        target_path = os.path.join(target_dir, ext_info.name)

        # 检查目标是否已存在
        if os.path.exists(target_path):
            return False, f"目标位置已存在同名扩展: {ext_info.name}"

        try:
            shutil.move(ext_info.path, target_path)
            type_name = "全局" if target_type == ExtensionType.GLOBAL else "用户"
            self._log(f"已将扩展 {ext_info.name} 移动到{type_name}插件目录")
            return True, f"成功将扩展移动到{type_name}插件目录"
        except Exception as e:
            error_msg = f"移动扩展失败: {e}"
            app_logger.error(error_msg, exc_info=True)
            return False, error_msg

    def _apply_github_mirror(self, url: str) -> str:
        """
        应用 GitHub 镜像到 URL

        Args:
            url: 原始 GitHub URL

        Returns:
            应用镜像后的 URL
        """
        mirror = self.config_manager.get("github.mirror", "github")

        if mirror == "github":
            return url

        # 检查是否是 GitHub URL
        github_patterns = [
            r"https?://github\.com/",
            r"https?://raw\.githubusercontent\.com/",
        ]

        is_github = any(re.match(pattern, url) for pattern in github_patterns)

        if not is_github:
            return url

        # 应用镜像
        if mirror == "gh-proxy.org":
            return f"https://gh-proxy.org/{url}"
        elif mirror == "ghfile.geekertao.top":
            return f"https://ghfile.geekertao.top/{url}"
        elif mirror == "gh.dpik.top":
            return f"https://gh.dpik.top/{url}"
        elif mirror == "github.dpik.top":
            return url.replace("github.com", "github.dpik.top")
        elif mirror == "github.acmsz.top":
            return url.replace("github.com", "github.acmsz.top")
        elif mirror == "git.yylx.win":
            return url.replace("github.com", "git.yylx.win")

        return url

    def install_from_git(
        self, repo_url: str, ext_type: ExtensionType, custom_name: Optional[str] = None
    ) -> Tuple[bool, str]:
        """
        从 Git 仓库安装扩展

        Args:
            repo_url: Git 仓库 URL
            ext_type: 扩展类型（全局/用户）
            custom_name: 自定义扩展名称（可选）

        Returns:
            (成功, 消息)
        """
        # 应用镜像
        original_url = repo_url
        repo_url = self._apply_github_mirror(repo_url)

        if original_url != repo_url:
            self._log(f"使用镜像: {repo_url}")

        # 确定目标目录
        if ext_type == ExtensionType.GLOBAL:
            target_dir = self._get_global_ext_path()
        else:
            target_dir = self._get_user_ext_path()

        self._ensure_dir_exists(target_dir)

        # 从 URL 提取扩展名称
        if custom_name:
            ext_name = custom_name
        else:
            # 从 URL 提取仓库名
            match = re.search(r"/([^/]+?)(?:\.git)?$", repo_url)
            if match:
                ext_name = match.group(1)
            else:
                return False, "无法从 URL 提取扩展名称，请提供自定义名称"

        target_path = os.path.join(target_dir, ext_name)

        # 检查是否已存在
        if os.path.exists(target_path):
            return False, f"扩展已存在: {ext_name}"

        try:
            self._log(f"正在从 Git 安装扩展: {ext_name}")

            # 获取 git 命令
            git_cmd, needs_quotes = _get_git_command()

            # 执行 git clone
            clone_cmd = _format_git_cmd(
                git_cmd, needs_quotes, f'clone "{repo_url}" "{target_path}"'
            )

            result = subprocess.run(
                clone_cmd,
                shell=True,
                capture_output=True,
                text=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )

            if result.returncode == 0:
                # 检查是否是有效的扩展
                if self._is_valid_extension(target_path):
                    self._log(f"成功安装扩展: {ext_name}")
                    return True, f"成功安装扩展: {ext_name}"
                else:
                    # 不是有效扩展，删除并返回错误
                    shutil.rmtree(target_path, ignore_errors=True)
                    return (
                        False,
                        "安装的仓库不是有效的 SillyTavern 扩展（缺少 manifest.json 或 index.js）",
                    )
            else:
                error_msg = result.stderr.strip() if result.stderr else "未知错误"
                return False, f"Git 克隆失败: {error_msg}"

        except Exception as e:
            error_msg = f"安装扩展失败: {e}"
            app_logger.error(error_msg, exc_info=True)
            # 清理可能残留的文件
            if os.path.exists(target_path):
                shutil.rmtree(target_path, ignore_errors=True)
            return False, error_msg

    def install_from_zip(
        self, zip_path: str, ext_type: ExtensionType, custom_name: Optional[str] = None
    ) -> Tuple[bool, str]:
        """
        从 ZIP 文件安装扩展

        Args:
            zip_path: ZIP 文件路径
            ext_type: 扩展类型（全局/用户）
            custom_name: 自定义扩展名称（可选）

        Returns:
            (成功, 消息)
        """
        if not os.path.exists(zip_path):
            return False, f"ZIP 文件不存在: {zip_path}"

        if not zipfile.is_zipfile(zip_path):
            return False, "无效的文件格式，请选择 ZIP 文件"

        # 确定目标目录
        if ext_type == ExtensionType.GLOBAL:
            target_dir = self._get_global_ext_path()
        else:
            target_dir = self._get_user_ext_path()

        self._ensure_dir_exists(target_dir)

        # 确定扩展名称
        if custom_name:
            ext_name = custom_name
        else:
            # 从文件名提取
            ext_name = os.path.splitext(os.path.basename(zip_path))[0]
            # 移除常见的后缀
            ext_name = re.sub(
                r"[-_](main|master|latest)$", "", ext_name, flags=re.IGNORECASE
            )

        target_path = os.path.join(target_dir, ext_name)

        # 检查是否已存在
        if os.path.exists(target_path):
            return False, f"扩展已存在: {ext_name}"

        try:
            self._log(f"正在从 ZIP 安装扩展: {ext_name}")

            # 创建临时目录解压
            import tempfile

            with tempfile.TemporaryDirectory() as temp_dir:
                # 解压 ZIP
                with zipfile.ZipFile(zip_path, "r") as zip_ref:
                    zip_ref.extractall(temp_dir)

                # 检查解压后的结构
                extracted_items = os.listdir(temp_dir)

                # 如果解压后只有一个目录，且用户没有指定自定义名称，使用该目录名
                if len(extracted_items) == 1 and os.path.isdir(
                    os.path.join(temp_dir, extracted_items[0])
                ):
                    source_path = os.path.join(temp_dir, extracted_items[0])
                    # 如果用户没有指定自定义名称，使用目录名
                    if not custom_name:
                        ext_name = extracted_items[0]
                        target_path = os.path.join(target_dir, ext_name)
                        if os.path.exists(target_path):
                            return False, f"扩展已存在: {ext_name}"
                else:
                    source_path = temp_dir

                # 检查是否是有效的扩展
                if self._is_valid_extension(source_path):
                    # 移动到目标位置
                    shutil.move(source_path, target_path)
                    self._log(f"成功安装扩展: {ext_name}")
                    return True, f"成功安装扩展: {ext_name}"
                else:
                    return (
                        False,
                        "ZIP 文件内容不是有效的 SillyTavern 扩展（缺少 manifest.json 或 index.js）",
                    )

        except Exception as e:
            error_msg = f"安装扩展失败: {e}"
            app_logger.error(error_msg, exc_info=True)
            # 清理可能残留的文件
            if os.path.exists(target_path):
                shutil.rmtree(target_path, ignore_errors=True)
            return False, error_msg

    def duplicate_extension(
        self,
        ext_info: ExtensionInfo,
        target_type: ExtensionType,
        new_name: Optional[str] = None,
    ) -> Tuple[bool, str]:
        """
        复制扩展到另一类型

        Args:
            ext_info: 扩展信息
            target_type: 目标类型
            new_name: 新名称（可选，默认使用原名称）

        Returns:
            (成功, 消息)
        """
        # 确定目标路径
        if target_type == ExtensionType.GLOBAL:
            target_dir = self._get_global_ext_path()
        else:
            target_dir = self._get_user_ext_path()

        self._ensure_dir_exists(target_dir)

        # 确定新名称
        if new_name:
            target_name = new_name
        else:
            target_name = ext_info.name

        target_path = os.path.join(target_dir, target_name)

        # 检查目标是否已存在
        if os.path.exists(target_path):
            return False, f"目标位置已存在同名扩展: {target_name}"

        try:
            # 复制目录
            shutil.copytree(ext_info.path, target_path)
            type_name = "全局" if target_type == ExtensionType.GLOBAL else "用户"
            self._log(f"已复制扩展 {ext_info.name} 到{type_name}插件目录")
            return True, f"成功复制扩展到{type_name}插件目录"
        except Exception as e:
            error_msg = f"复制扩展失败: {e}"
            app_logger.error(error_msg, exc_info=True)
            return False, error_msg

    def rename_extension(
        self, ext_info: ExtensionInfo, new_name: str
    ) -> Tuple[bool, str]:
        """
        重命名扩展

        Args:
            ext_info: 扩展信息
            new_name: 新名称

        Returns:
            (成功, 消息)
        """
        if not new_name or new_name.strip() == "":
            return False, "新名称不能为空"

        new_name = new_name.strip()

        # 检查名称是否合法
        if not re.match(r"^[\w\-]+$", new_name):
            return False, "扩展名称只能包含字母、数字、下划线和短横线"

        if new_name == ext_info.name:
            return False, "新名称与原名称相同"

        # 确定目标路径
        if ext_info.ext_type == ExtensionType.GLOBAL:
            target_dir = self._get_global_ext_path()
        else:
            target_dir = self._get_user_ext_path()

        target_path = os.path.join(target_dir, new_name)

        # 检查目标是否已存在
        if os.path.exists(target_path):
            return False, f"已存在同名扩展: {new_name}"

        try:
            shutil.move(ext_info.path, target_path)
            self._log(f"已将扩展 {ext_info.name} 重命名为 {new_name}")
            return True, f"成功重命名扩展为: {new_name}"
        except Exception as e:
            error_msg = f"重命名扩展失败: {e}"
            app_logger.error(error_msg, exc_info=True)
            return False, error_msg


# 全局扩展管理器实例
_extension_manager_instance = None
_extension_manager_lock = threading.Lock()


def get_extension_manager(
    log_callback: Optional[Callable[[str], None]] = None,
) -> ExtensionManager:
    """
    获取扩展管理器实例（单例模式）

    Args:
        log_callback: 日志回调函数

    Returns:
        ExtensionManager 实例
    """
    global _extension_manager_instance

    if _extension_manager_instance is None:
        with _extension_manager_lock:
            if _extension_manager_instance is None:
                _extension_manager_instance = ExtensionManager(log_callback)

    return _extension_manager_instance
