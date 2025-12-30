import os
import subprocess
from env import Env

def checkout_st_version(commit_hash, st_dir=None):
    """
    切换SillyTavern到指定commit

    Args:
        commit_hash (str): 目标commit的完整hash或前7位
        st_dir (str): SillyTavern目录路径，默认为当前目录下的SillyTavern文件夹

    Returns:
        tuple: (success: bool, message: str)
    """
    if st_dir is None:
        st_dir = os.path.join(os.getcwd(), "SillyTavern")

    # 检查目录是否存在
    if not os.path.exists(st_dir):
        return False, "SillyTavern目录不存在"

    # 检查是否是Git仓库
    git_dir = os.path.join(st_dir, ".git")
    if not os.path.exists(git_dir):
        return False, "SillyTavern目录不是Git仓库"

    try:
        env = Env()
        git_path = env.get_git_path()

        # 首先尝试正常checkout
        command = f'"{git_path}git" checkout {commit_hash}'

        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW
        )

        if result.returncode == 0:
            return True, f"成功切换到commit {commit_hash[:7]}"

        error_msg = result.stderr.strip() if result.stderr else "未知错误"

        # 如果是本地更改冲突，尝试使用 --merge 参数
        if "would be overwritten by checkout" in error_msg or "local changes" in error_msg.lower():
            print(f"检测到本地更改冲突，尝试使用--merge参数: {error_msg}")

            # 尝试使用 --merge 参数（保留本地更改）
            command_merge = f'"{git_path}git" checkout --merge {commit_hash}'

            result_merge = subprocess.run(
                command_merge,
                shell=True,
                capture_output=True,
                text=True,
                cwd=st_dir,
                creationflags=subprocess.CREATE_NO_WINDOW
            )

            if result_merge.returncode == 0:
                return True, f"成功切换到commit {commit_hash[:7]}（保留了本地更改）"
            else:
                # 如果 --merge 也失败，尝试使用 stash
                print("--merge参数失败，尝试使用stash保存本地更改")

                # 先保存本地更改
                stash_cmd = f'"{git_path}git" stash push -m "版本切换前保存{commit_hash[:7]}"'
                stash_result = subprocess.run(
                    stash_cmd,
                    shell=True,
                    capture_output=True,
                    text=True,
                    cwd=st_dir,
                    creationflags=subprocess.CREATE_NO_WINDOW
                )

                if stash_result.returncode != 0:
                    return False, f"保存本地更改失败: {stash_result.stderr.strip() if stash_result.stderr else '未知错误'}"

                print("本地更改已暂存，执行版本切换...")

                # 再次尝试checkout
                result_final = subprocess.run(
                    command,
                    shell=True,
                    capture_output=True,
                    text=True,
                    cwd=st_dir,
                    creationflags=subprocess.CREATE_NO_WINDOW
                )

                if result_final.returncode == 0:
                    return True, f"成功切换到commit {commit_hash[:7]}（本地更改已暂存，可用git stash恢复）"
                else:
                    final_error = result_final.stderr.strip() if result_final.stderr else "未知错误"
                    return False, f"切换失败: {final_error}"
        else:
            return False, f"切换失败: {error_msg}"

    except Exception as e:
        print(f"切换过程中发生异常: {str(e)}")
        return False, f"切换过程中发生错误: {str(e)}"


def check_git_status(st_dir=None):
    """
    检查Git工作区状态（是否有未提交的更改）

    Args:
        st_dir (str): SillyTavern目录路径，默认为当前目录下的SillyTavern文件夹

    Returns:
        tuple: (is_clean: bool, message: str)
    """
    if st_dir is None:
        st_dir = os.path.join(os.getcwd(), "SillyTavern")

    try:
        env = Env()
        git_path = env.get_git_path()

        # 检查是否有未提交的更改
        result = subprocess.run(
            f'"{git_path}git" status --porcelain',
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW
        )

        # 如果输出为空，说明工作区干净
        if not result.stdout.strip():
            return True, "工作区干净"
        else:
            # 统计修改的文件
            modified_lines = result.stdout.strip().split('\n')
            modified_count = len([line for line in modified_lines if line.strip()])
            return False, f"检测到{modified_count}个文件有未提交的更改"

    except Exception as e:
        return False, f"检查Git状态时出错: {str(e)}"


def get_current_commit(st_dir=None):
    """
    获取当前SillyTavern的commit hash

    Args:
        st_dir (str): SillyTavern目录路径，默认为当前目录下的SillyTavern文件夹

    Returns:
        tuple: (success: bool, commit_hash: str or None, message: str)
    """
    if st_dir is None:
        st_dir = os.path.join(os.getcwd(), "SillyTavern")

    try:
        env = Env()
        git_path = env.get_git_path()

        result = subprocess.run(
            f'"{git_path}git" rev-parse HEAD',
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW
        )

        if result.returncode == 0:
            commit_hash = result.stdout.strip()
            return True, commit_hash, "成功获取当前commit"
        else:
            return False, None, f"获取commit失败: {result.stderr}"

    except Exception as e:
        return False, None, f"获取commit时出错: {str(e)}"


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

