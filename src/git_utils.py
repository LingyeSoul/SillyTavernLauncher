import os
import subprocess
from env import Env

def switch_git_remote_to_gitee(st_dir=None):
    """
    将已克隆的SillyTavern仓库的远程地址切换为Gitee镜像地址
    
    Args:
        st_dir (str): SillyTavern目录路径，默认为当前目录下的SillyTavern文件夹
    """
    if st_dir is None:
        st_dir = os.path.join(os.getcwd(), "SillyTavern")
    
    # 检查SillyTavern目录是否存在
    if not os.path.exists(st_dir):
        return False, "SillyTavern目录不存在"
    
    # 检查是否是Git仓库
    git_dir = os.path.join(st_dir, ".git")
    if not os.path.exists(git_dir):
        return False, "SillyTavern目录不是Git仓库"
    
    try:
        # 切换远程地址为Gitee镜像
        env = Env()
        git_path = env.get_git_path()
        
        # 设置新的远程地址
        command = f'\"{git_path}git\" remote set-url origin https://gitee.com/lingyesoul/SillyTavern.git'
        
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir
        )
        
        if result.returncode == 0:
            return True, "成功切换到Gitee镜像仓库"
        else:
            return False, f"切换失败: {result.stderr}"
            
    except Exception as e:
        return False, f"切换过程中发生错误: {str(e)}"

