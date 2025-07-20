import sys
import os
import subprocess
from packaging import version

class SysEnv:
    def __init__(self):
        self.base_dir = os.getcwd()
        self.st_dir = os.path.join(self.base_dir, "SillyTavern\\")
        self.system_git_path = None
        self.system_node_path = None
        self.gitroot_dir = self.get_git_root_dir() if self.system_git_path else None

    def get_git_root_dir(self):
        """从git.exe路径获取Git安装根目录"""
        if self.system_git_path:
            # 如果git.exe在cmd子目录中，返回上级目录
            if os.path.basename(os.path.dirname(self.system_git_path)) == 'cmd':
                return os.path.dirname(os.path.dirname(self.system_git_path))
            # 如果git.exe在bin子目录中，返回上级目录
            elif os.path.basename(os.path.dirname(self.system_git_path)) == 'bin':
                return os.path.dirname(os.path.dirname(self.system_git_path))
            # 其他情况直接返回system_git_path
            else:
                return self.system_git_path
        return None

    def checkSysEnv(self):
        git_check = self.check_system_git()
        node_check = self.check_system_node()
        if git_check is True and node_check is True:
            return True
        elif git_check is not True:
            return 'System Git Not Found'
        else:
            return 'System Node Not Found'

    def check_system_git(self):
        try:
            # First check if git is available
            version_result = subprocess.run(['git', '--version'], capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
            if version_result.returncode != 0:
                return 'Git is not installed on system'
            
            # Search for git executable in PATH
            for path in os.environ['PATH'].split(os.pathsep):
                git_path = os.path.join(path, 'git.exe')
                if os.path.isfile(git_path):
                    self.system_git_path = path.rstrip('\\') + '\\'
                    return True
            return 'Git is not installed on system'
        except FileNotFoundError:
            return 'Git is not installed on system'

    def check_system_node(self):
        try:
            version_result = subprocess.run(['node', '--version'], capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
            if version_result.returncode != 0:
                return 'Node.js is not installed on system'
            
            node_version = version_result.stdout.strip().lstrip('v')
            if version.parse(node_version) < version.parse('18.0.0'):
                return f'Node.js version {node_version} is too old, requires 18.x LTS or higher'
            
            # Search for node executable in PATH
            for path in os.environ['PATH'].split(os.pathsep):
                node_path = os.path.join(path, 'node.exe')
                if os.path.isfile(node_path):
                    self.system_node_path = path.rstrip('\\') + '\\'
                    return True
            return 'Node.js is not installed on system'
        except FileNotFoundError:
            return 'Node.js is not installed on system'
        
    def get_git_path(self):
        return self.system_git_path
    
    def get_node_path(self):
        return self.system_node_path
    def checkST(self):
        if not os.path.exists(self.st_dir):
            return False
        else:
            if not os.path.isfile(os.path.join(self.st_dir, "package.json")):
                return False
            else:
                if not os.path.isfile(os.path.join(self.st_dir, "server.js")):
                    return False
                else:
                    return True
    def check_nodemodules(self):
        if not os.path.exists(os.path.join(self.st_dir, "node_modules")):
            return False
        else:
            return True