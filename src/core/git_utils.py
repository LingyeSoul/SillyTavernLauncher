import os
import subprocess
from features.system.env import Env
from config.config_manager import ConfigManager
from utils.logger import app_logger


def _get_git_command():
    """
    根据配置获取正确的git命令路径

    Returns:
        tuple: (git_cmd: str, needs_quotes: bool)
        - git_cmd: git命令或完整路径
        - needs_quotes: 是否需要引号包裹（系统环境不需要，内置环境需要）
    """
    config_manager = ConfigManager()
    use_sys_env = config_manager.get("use_sys_env", False)

    if use_sys_env:
        # 使用系统环境，直接调用 git（不需要引号）
        return "git", False
    else:
        # 使用内置环境，获取完整路径（需要引号包裹路径中的空格）
        env = Env()
        git_dir = env.get_git_path()
        git_exe = os.path.join(git_dir, "git.exe")  # 添加可执行文件名
        return git_exe, True


def _format_git_cmd(git_cmd, needs_quotes, args):
    """
    格式化git命令字符串

    Args:
        git_cmd: git命令或路径
        needs_quotes: 是否需要引号包裹
        args: 命令参数

    Returns:
        str: 格式化后的完整命令
    """
    if needs_quotes:
        # 内置环境：路径可能包含空格，需要引号
        return f'"{git_cmd}" {args}'
    else:
        # 系统环境：直接使用git命令
        return f"{git_cmd} {args}"


def checkout_st_version(commit_hash, st_dir=None):
    """
    切换SillyTavern到指定commit（保持在release分支上，避免detached HEAD）

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
        git_cmd, needs_quotes = _get_git_command()

        # 步骤1：检查当前分支状态
        check_branch = subprocess.run(
            _format_git_cmd(git_cmd, needs_quotes, "rev-parse --abbrev-ref HEAD"),
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

        current_branch = (
            check_branch.stdout.strip() if check_branch.returncode == 0 else ""
        )

        # 步骤2：如果是detached HEAD状态，先切换回release分支
        if current_branch == "HEAD":
            print("检测到detached HEAD状态，切换回release分支...")

            # 尝试切换到release分支
            checkout_release = subprocess.run(
                _format_git_cmd(git_cmd, needs_quotes, "checkout release"),
                shell=True,
                capture_output=True,
                text=True,
                cwd=st_dir,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )

            if checkout_release.returncode != 0:
                # 如果本地没有release分支，从远程创建
                print("本地没有release分支，从远程创建...")
                checkout_release = subprocess.run(
                    _format_git_cmd(
                        git_cmd, needs_quotes, "checkout -b release origin/release"
                    ),
                    shell=True,
                    capture_output=True,
                    text=True,
                    cwd=st_dir,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )

                if checkout_release.returncode != 0:
                    return (
                        False,
                        f"无法切换到release分支: {checkout_release.stderr.strip() if checkout_release.stderr else '未知错误'}",
                    )

        # 步骤3：确保在release分支上（如果当前在其他分支，切换到release）
        if current_branch != "release":
            print(f"当前在 {current_branch} 分支，切换到release分支...")

            checkout_release = subprocess.run(
                _format_git_cmd(git_cmd, needs_quotes, "checkout release"),
                shell=True,
                capture_output=True,
                text=True,
                cwd=st_dir,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )

            if checkout_release.returncode != 0:
                return (
                    False,
                    f"切换到release分支失败: {checkout_release.stderr.strip() if checkout_release.stderr else '未知错误'}",
                )

        # 步骤4：检查工作区状态
        status_result = subprocess.run(
            _format_git_cmd(git_cmd, needs_quotes, "status --porcelain"),
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

        # 步骤5：如果有未提交的更改，先保存
        if status_result.stdout.strip():
            print("检测到未提交的更改，使用stash保存...")

            # 过滤掉package-lock.json的更改
            modified_lines = status_result.stdout.strip().split("\n")
            non_package_lock_changes = [
                line
                for line in modified_lines
                if line.strip() and "package-lock.json" not in line
            ]

            if non_package_lock_changes:
                stash_cmd = _format_git_cmd(
                    git_cmd,
                    needs_quotes,
                    f'stash push -m "版本切换前保存{commit_hash[:7]}"',
                )
                stash_result = subprocess.run(
                    stash_cmd,
                    shell=True,
                    capture_output=True,
                    text=True,
                    cwd=st_dir,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )

                if stash_result.returncode != 0:
                    return (
                        False,
                        f"保存本地更改失败: {stash_result.stderr.strip() if stash_result.stderr else '未知错误'}",
                    )
                print("本地更改已暂存")
            else:
                # 只有package-lock.json被修改，恢复它
                subprocess.run(
                    _format_git_cmd(
                        git_cmd, needs_quotes, "checkout -- package-lock.json"
                    ),
                    shell=True,
                    capture_output=True,
                    text=True,
                    cwd=st_dir,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )

        # 步骤6：从远程获取最新提交（确保本地有目标commit）
        print("正在从远程获取最新提交...")
        fetch_cmd = _format_git_cmd(git_cmd, needs_quotes, "fetch origin release")

        fetch_result = subprocess.run(
            fetch_cmd,
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

        if fetch_result.returncode != 0:
            # fetch失败但继续尝试，可能本地已有目标commit
            print(
                f"获取远程提交失败（继续尝试）: {fetch_result.stderr.strip() if fetch_result.stderr else '未知错误'}"
            )

        # 步骤6.5：验证commit是否存在，如果不存在尝试获取完整历史
        print(f"验证commit {commit_hash[:7]}是否存在...")
        verify_cmd = _format_git_cmd(
            git_cmd, needs_quotes, f"cat-file -t {commit_hash}"
        )
        verify_result = subprocess.run(
            verify_cmd,
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

        if verify_result.returncode != 0:
            # commit不存在，返回错误提示
            return (
                False,
                f"切换失败: 该版本({commit_hash[:7]})在远程仓库中不存在。\n"
                f"建议: 尝试更新到最新版本后再试。",
            )

        # 步骤7：使用git reset --hard切换到指定commit（保持在release分支上）
        print(f"在release分支上切换到commit {commit_hash[:7]}...")
        reset_cmd = _format_git_cmd(
            git_cmd, needs_quotes, f"reset --hard {commit_hash}"
        )

        reset_result = subprocess.run(
            reset_cmd,
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

        if reset_result.returncode == 0:
            # 验证当前状态
            verify_branch = subprocess.run(
                _format_git_cmd(git_cmd, needs_quotes, "rev-parse --abbrev-ref HEAD"),
                shell=True,
                capture_output=True,
                text=True,
                cwd=st_dir,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )

            if verify_branch.returncode == 0:
                branch_name = verify_branch.stdout.strip()
                if branch_name == "release":
                    return True, f"成功切换到版本 {commit_hash[:7]}（在release分支上）"
                else:
                    # 理论上不应该发生，但万一发生了
                    return False, f"切换后未在release分支上，当前在: {branch_name}"
            else:
                return True, f"成功切换到版本 {commit_hash[:7]}"
        else:
            error_msg = (
                reset_result.stderr.strip() if reset_result.stderr else "未知错误"
            )
            return False, f"切换失败: {error_msg}"

    except Exception as e:
        print(f"切换过程中发生异常: {str(e)}")
        import traceback

        traceback.print_exc()
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
        git_cmd, needs_quotes = _get_git_command()

        # 检查是否有未提交的更改
        result = subprocess.run(
            _format_git_cmd(git_cmd, needs_quotes, "status --porcelain"),
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

        # 如果输出为空，说明工作区干净
        if not result.stdout.strip():
            return True, "工作区干净"
        else:
            # 检查修改的文件
            modified_lines = result.stdout.strip().split("\n")
            # 过滤掉package-lock.json的更改（这是由于使用镜像NPM源导致的）
            non_package_lock_changes = [
                line
                for line in modified_lines
                if line.strip() and "package-lock.json" not in line
            ]

            if not non_package_lock_changes:
                # 只有package-lock.json被修改，自动恢复它
                try:
                    subprocess.run(
                        _format_git_cmd(
                            git_cmd, needs_quotes, "checkout -- package-lock.json"
                        ),
                        shell=True,
                        cwd=st_dir,
                        capture_output=True,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                    return True, "工作区干净（已自动恢复package-lock.json）"
                except:
                    pass

            # 如果还有其他文件被修改，返回错误
            modified_count = len(non_package_lock_changes)
            if modified_count > 0:
                return False, f"检测到{modified_count}个文件有未提交的更改"
            else:
                return True, "工作区干净"

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
        git_cmd, needs_quotes = _get_git_command()

        result = subprocess.run(
            _format_git_cmd(git_cmd, needs_quotes, "rev-parse HEAD"),
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW,
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
        git_cmd, needs_quotes = _get_git_command()

        # 设置新的远程地址
        command = _format_git_cmd(
            git_cmd,
            needs_quotes,
            "remote set-url origin https://gitee.com/lingyesoul/SillyTavern.git",
        )

        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, cwd=st_dir
        )

        if result.returncode == 0:
            return True, "成功切换到Gitee镜像仓库"
        else:
            return False, f"切换失败: {result.stderr}"

    except Exception as e:
        return False, f"切换过程中发生错误: {str(e)}"



def cleanup_git_state(st_dir=None):
    """
    清理Git仓库的未完成状态（merge、rebase等）
    
    检测并清理以下状态：
    - MERGE_HEAD（合并冲突状态）
    - rebase-apply（旧版rebase状态）
    - rebase-merge（新版rebase状态）
    - CHERRY_PICK_HEAD（cherry-pick状态）
    - REVERT_HEAD（revert状态）
    
    执行清理命令：
    - git merge --abort
    - git rebase --abort
    - git reset --hard HEAD
    
    Args:
        st_dir (str): SillyTavern目录路径，默认为当前目录下的SillyTavern文件夹
    
    Returns:
        tuple: (success: bool, message: str)
    """
    if st_dir is None:
        st_dir = os.path.join(os.getcwd(), "SillyTavern")
    
    # 检查目录是否存在
    if not os.path.exists(st_dir):
        return True, "SillyTavern目录不存在，无需清理"
    
    # 检查是否是Git仓库
    git_dir = os.path.join(st_dir, ".git")
    if not os.path.exists(git_dir):
        return True, "不是Git仓库，无需清理"
    
    try:
        git_cmd, needs_quotes = _get_git_command()
        
        # 检测未完成状态的标志文件
        merge_head = os.path.join(st_dir, ".git", "MERGE_HEAD")
        rebase_apply = os.path.join(st_dir, ".git", "rebase-apply")
        rebase_merge = os.path.join(st_dir, ".git", "rebase-merge")
        cherry_pick_head = os.path.join(st_dir, ".git", "CHERRY_PICK_HEAD")
        revert_head = os.path.join(st_dir, ".git", "REVERT_HEAD")
        
        needs_cleanup = (
            os.path.exists(merge_head) or
            os.path.exists(rebase_apply) or
            os.path.exists(rebase_merge) or
            os.path.exists(cherry_pick_head) or
            os.path.exists(revert_head)
        )
        
        if not needs_cleanup:
            return True, "Git状态干净，无需清理"
        
        print("检测到Git未完成状态，开始清理...")
        
        # 清理步骤1：中止合并操作
        if os.path.exists(merge_head):
            print("检测到未完成的合并操作，执行 merge --abort...")
            merge_abort_result = subprocess.run(
                _format_git_cmd(git_cmd, needs_quotes, "merge --abort"),
                shell=True,
                capture_output=True,
                text=True,
                cwd=st_dir,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if merge_abort_result.returncode == 0:
                print("✓ 合并操作已中止")
            else:
                print(f"⚠ 中止合并失败: {merge_abort_result.stderr.strip() if merge_abort_result.stderr else '未知错误'}")
        
        # 清理步骤2：中止rebase操作
        rebase_dir = None
        if os.path.exists(rebase_merge):
            rebase_dir = rebase_merge
        elif os.path.exists(rebase_apply):
            rebase_dir = rebase_apply
        
        if rebase_dir:
            print(f"检测到未完成的rebase操作，执行 rebase --abort...")
            rebase_abort_result = subprocess.run(
                _format_git_cmd(git_cmd, needs_quotes, "rebase --abort"),
                shell=True,
                capture_output=True,
                text=True,
                cwd=st_dir,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if rebase_abort_result.returncode == 0:
                print("✓ Rebase操作已中止")
            else:
                print(f"⚠ 中止rebase失败: {rebase_abort_result.stderr.strip() if rebase_abort_result.stderr else '未知错误'}")
        
        # 清理步骤3：中止cherry-pick操作
        if os.path.exists(cherry_pick_head):
            print("检测到未完成的cherry-pick操作，执行 cherry-pick --abort...")
            cherry_abort_result = subprocess.run(
                _format_git_cmd(git_cmd, needs_quotes, "cherry-pick --abort"),
                shell=True,
                capture_output=True,
                text=True,
                cwd=st_dir,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if cherry_abort_result.returncode == 0:
                print("✓ Cherry-pick操作已中止")
            else:
                print(f"⚠ 中止cherry-pick失败: {cherry_abort_result.stderr.strip() if cherry_abort_result.stderr else '未知错误'}")
        
        # 清理步骤4：中止revert操作
        if os.path.exists(revert_head):
            print("检测到未完成的revert操作，执行 revert --abort...")
            revert_abort_result = subprocess.run(
                _format_git_cmd(git_cmd, needs_quotes, "revert --abort"),
                shell=True,
                capture_output=True,
                text=True,
                cwd=st_dir,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if revert_abort_result.returncode == 0:
                print("✓ Revert操作已中止")
            else:
                print(f"⚠ 中止revert失败: {revert_abort_result.stderr.strip() if revert_abort_result.stderr else '未知错误'}")
        
        # 清理步骤5：清理工作区索引（reset --hard HEAD）
        print("清理工作区索引...")
        reset_result = subprocess.run(
            _format_git_cmd(git_cmd, needs_quotes, "reset --hard HEAD"),
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        
        if reset_result.returncode == 0:
            print("✓ 工作区已清理")
        else:
            print(f"⚠ 清理工作区失败: {reset_result.stderr.strip() if reset_result.stderr else '未知错误'}")
        
        # 清理步骤6：清理可能存在的未提交更改
        print("检查并清理未提交的更改...")
        status_result = subprocess.run(
            _format_git_cmd(git_cmd, needs_quotes, "status --porcelain"),
            shell=True,
            capture_output=True,
            text=True,
            cwd=st_dir,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        
        if status_result.stdout.strip():
            # 过滤掉package-lock.json的更改（由于使用镜像NPM源导致）
            modified_lines = status_result.stdout.strip().split("\n")
            non_package_lock_changes = [
                line
                for line in modified_lines
                if line.strip() and "package-lock.json" not in line
            ]
            
            if non_package_lock_changes:
                print(f"⚠ 检测到{len(non_package_lock_changes)}个未提交的更改，使用reset --hard清理")
                reset_clean_result = subprocess.run(
                    _format_git_cmd(git_cmd, needs_quotes, "reset --hard HEAD"),
                    shell=True,
                    capture_output=True,
                    text=True,
                    cwd=st_dir,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                if reset_clean_result.returncode == 0:
                    print("✓ 未提交的更改已清理")
            else:
                # 只有package-lock.json被修改，恢复它
                subprocess.run(
                    _format_git_cmd(git_cmd, needs_quotes, "checkout -- package-lock.json"),
                    shell=True,
                    capture_output=True,
                    text=True,
                    cwd=st_dir,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                print("✓ package-lock.json已恢复")
        
        # 清理步骤7：验证清理结果（检查标志文件是否已移除）
        remaining_flags = []
        for flag_path in [merge_head, rebase_apply, rebase_merge, cherry_pick_head, revert_head]:
            if os.path.exists(flag_path):
                remaining_flags.append(os.path.basename(flag_path))
        
        if remaining_flags:
            error_msg = f"清理失败，仍存在的状态文件: {', '.join(remaining_flags)}"
            app_logger.error(error_msg)
            return False, error_msg
        
        app_logger.info("Git状态清理验证通过")
        
        return True, "Git状态清理成功"
        
    except Exception as e:
        error_msg = f"清理Git状态时出错: {str(e)}"
        app_logger.error(error_msg)
        return False, error_msg
