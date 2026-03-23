"""
扩展管理页面

提供 SillyTavern 扩展的管理页面，包括：
- 全局插件和用户插件的列表展示
- Git 安装、ZIP 安装
- 插件转换、删除
"""

import threading
from functools import partial

import flet as ft

from features.extensions.extension_manager import (
    ExtensionInfo,
    ExtensionType,
    get_extension_manager,
)
from utils.logger import app_logger


def create_extension_card(ext_info: ExtensionInfo, on_action, page: ft.Page):
    """
    创建扩展卡片

    Args:
        ext_info: 扩展信息
        on_action: 操作回调函数 (action_type, ext_info)
        page: Flet页面对象
    """
    # 图标颜色根据有效性变化
    icon_color = ft.Colors.GREEN_600 if ext_info.is_valid else ft.Colors.ORANGE_600

    # 标题行
    title_row = ft.Row(
        [
            ft.Icon(
                ft.Icons.EXTENSION if ext_info.is_valid else ft.Icons.WARNING,
                color=icon_color,
                size=24,
            ),
            ft.Text(
                ext_info.display_name, size=16, weight=ft.FontWeight.BOLD, expand=True
            ),
            ft.Text(ext_info.version, size=12, color=ft.Colors.GREY_600),
        ],
        alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
    )

    # 描述
    description = ft.Text(
        ext_info.description or "暂无描述",
        size=13,
        color=ft.Colors.GREY_700 if ext_info.description else ft.Colors.GREY_400,
        max_lines=2,
        overflow=ft.TextOverflow.ELLIPSIS,
    )

    # 作者和路径信息
    info_row = ft.Row(
        [
            ft.Text(f"作者: {ext_info.author}", size=11, color=ft.Colors.GREY_500),
            ft.Text(f"名称: {ext_info.name}", size=11, color=ft.Colors.GREY_500),
        ],
        alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
    )

    # 错误提示（如果无效）
    error_control = None
    if not ext_info.is_valid:
        error_control = ft.Text(
            f"⚠ {ext_info.error_msg}", size=11, color=ft.Colors.ORANGE_600
        )

    # 操作按钮（已删除复制按钮）
    action_buttons = ft.Row(
        [
            ft.IconButton(
                icon=ft.Icons.SWAP_HORIZ,
                tooltip="转换到"
                + (
                    "用户插件"
                    if ext_info.ext_type == ExtensionType.GLOBAL
                    else "全局插件"
                ),
                on_click=lambda e: on_action("move", ext_info),
            ),
            ft.IconButton(
                icon=ft.Icons.DELETE,
                tooltip="删除",
                icon_color=ft.Colors.RED_400,
                on_click=lambda e: on_action("delete", ext_info),
            ),
        ],
        alignment=ft.MainAxisAlignment.END,
        spacing=5,
    )

    # 构建内容
    content_controls = [
        title_row,
        ft.Divider(height=8, color=ft.Colors.TRANSPARENT),
        description,
        ft.Divider(height=4, color=ft.Colors.TRANSPARENT),
        info_row,
    ]

    if error_control:
        content_controls.append(error_control)

    content_controls.append(action_buttons)

    return ft.Card(
        content=ft.Container(
            content=ft.Column(content_controls, spacing=2), padding=15, width=400
        )
    )


def create_extension_page(page: ft.Page, terminal, ui_event):
    """
    创建扩展管理页面视图

    Args:
        page: Flet页面对象
        terminal: 终端对象（用于日志输出）
        ui_event: UiEvent对象（事件处理）

    Returns:
        ft.Column: 扩展管理视图
    """
    ext_manager = get_extension_manager(lambda msg: terminal.add_log(msg))

    # 状态变量
    current_dialog = None

    # 扩展列表容器
    global_list = ft.Column(scroll=ft.ScrollMode.AUTO, expand=True, spacing=10)
    user_list = ft.Column(scroll=ft.ScrollMode.AUTO, expand=True, spacing=10)

    def log(message: str):
        """输出日志"""
        terminal.add_log(message)
        app_logger.info(message)

    def show_snackbar(message: str, color=ft.Colors.BLUE_600):
        """显示提示条"""
        snackbar = ft.SnackBar(
            content=ft.Text(message, color=ft.Colors.WHITE),
            bgcolor=color,
            duration=3000,
        )
        page.show_dialog(snackbar)

    def show_dialog(dialog):
        """显示对话框"""
        nonlocal current_dialog
        if current_dialog:
            try:
                page.pop_dialog()
            except:
                pass
        current_dialog = dialog
        page.show_dialog(dialog)

    def close_dialog():
        """关闭当前对话框"""
        try:
            page.pop_dialog()
        except:
            pass

    async def close_dialog_async():
        """异步关闭当前对话框"""
        close_dialog()

    async def show_snackbar_async(message: str, color=ft.Colors.BLUE_600):
        """异步显示提示条"""
        show_snackbar(message, color)
    def refresh_lists():
        """刷新扩展列表"""
        log("正在刷新扩展列表...")

        # 清空现有列表
        global_list.controls.clear()
        user_list.controls.clear()

        # 加载全局插件
        global_exts = ext_manager.scan_extensions(ExtensionType.GLOBAL)
        if global_exts:
            for ext in global_exts:
                card = create_extension_card(ext, on_extension_action, page)
                global_list.controls.append(card)
        else:
            global_list.controls.append(
                ft.Container(
                    content=ft.Column(
                        [
                            ft.Icon(
                                ft.Icons.FOLDER_OPEN, size=48, color=ft.Colors.GREY_400
                            ),
                            ft.Text("暂无全局插件", color=ft.Colors.GREY_500),
                        ],
                        horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                    ),
                    alignment=ft.Alignment(0, 0),
                    padding=50,
                )
            )

        # 加载用户插件
        user_exts = ext_manager.scan_extensions(ExtensionType.USER)
        if user_exts:
            for ext in user_exts:
                card = create_extension_card(ext, on_extension_action, page)
                user_list.controls.append(card)
        else:
            user_list.controls.append(
                ft.Container(
                    content=ft.Column(
                        [
                            ft.Icon(
                                ft.Icons.FOLDER_OPEN, size=48, color=ft.Colors.GREY_400
                            ),
                            ft.Text("暂无用户插件", color=ft.Colors.GREY_500),
                        ],
                        horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                    ),
                    alignment=ft.Alignment(0, 0),
                    padding=50,
                )
            )

        page.update()
        log(f"已加载 {len(global_exts)} 个全局插件, {len(user_exts)} 个用户插件")

    def on_extension_action(action: str, ext_info: ExtensionInfo):
        """处理扩展操作（已删除duplicate操作）"""
        if action == "delete":
            show_delete_confirm_dialog(ext_info)
        elif action == "move":
            move_extension(ext_info)

    def show_delete_confirm_dialog(ext_info: ExtensionInfo):
        """显示删除确认对话框"""
        type_name = "全局" if ext_info.ext_type == ExtensionType.GLOBAL else "用户"

        def on_confirm(e):
            close_dialog()
            success, message = ext_manager.delete_extension(ext_info)
            if success:
                show_snackbar(message, ft.Colors.GREEN_600)
                refresh_lists()
            else:
                show_snackbar(message, ft.Colors.RED_600)

        def on_cancel(e):
            close_dialog()

        dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("确认删除", color=ft.Colors.RED_600),
            content=ft.Text(
                f'确定要删除{type_name}插件 "{ext_info.display_name}" 吗？\n\n'
                f"插件名称: {ext_info.name}\n"
                f"此操作不可恢复！"
            ),
            actions=[
                ft.TextButton("取消", on_click=on_cancel),
                ft.ElevatedButton(
                    "删除",
                    color=ft.Colors.WHITE,
                    bgcolor=ft.Colors.RED_600,
                    on_click=on_confirm,
                ),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )

        show_dialog(dialog)

    def move_extension(ext_info: ExtensionInfo):
        """移动扩展到另一类型"""
        target_type = (
            ExtensionType.USER
            if ext_info.ext_type == ExtensionType.GLOBAL
            else ExtensionType.GLOBAL
        )

        success, message = ext_manager.move_extension(ext_info, target_type)
        if success:
            show_snackbar(message, ft.Colors.GREEN_600)
            refresh_lists()
        else:
            show_snackbar(message, ft.Colors.RED_600)


    def show_git_install_dialog():
        """显示Git安装对话框（带取消功能）"""
        url_field = ft.TextField(
            label="Git 仓库地址",
            prefix_icon=ft.Icons.LINK,
        )

        type_dropdown = ft.Dropdown(
            label="安装到",
            value="global",
            options=[
                ft.dropdown.Option("global", "全局插件"),
                ft.dropdown.Option("user", "用户插件"),
            ],
        )

        def on_confirm(e):
            url = url_field.value.strip()
            if not url:
                show_snackbar("请输入 Git 仓库地址", ft.Colors.RED_600)
                return

            # 验证URL格式
            if not (
                url.startswith("http://")
                or url.startswith("https://")
                or url.startswith("git@")
            ):
                show_snackbar("无效的 Git 仓库地址", ft.Colors.RED_600)
                return

            ext_type = (
                ExtensionType.GLOBAL
                if type_dropdown.value == "global"
                else ExtensionType.USER
            )
            custom_name = None

            close_dialog()

            # 创建进度对话框（带取消按钮）
            progress_bar = ft.ProgressBar(width=400, value=0)
            status_text = ft.Text("准备下载...", size=14)
            cancel_flag = {"cancelled": False}

            def on_cancel_install(e):
                cancel_flag["cancelled"] = True
                status_text.value = "正在取消..."
                page.update()

            progress_dialog = ft.AlertDialog(
                modal=True,
                title=ft.Text("正在安装扩展"),
                content=ft.Column(
                    [
                        ft.Text(f"从 Git 仓库安装: {url}"),
                        ft.Divider(),
                        status_text,
                        progress_bar,
                    ],
                    tight=True,
                    spacing=10,
                ),
                actions=[
                    ft.TextButton("取消", on_click=on_cancel_install),
                ],
                actions_alignment=ft.MainAxisAlignment.END,
            )
            show_dialog(progress_dialog)

            # 在后台线程中执行安装
            def install():
                async def update_progress_async(status: str, progress: float):
                    if cancel_flag["cancelled"]:
                        return False
                    status_text.value = status
                    progress_bar.value = progress
                    page.update()
                    return True

                def update_progress(status: str, progress: float):
                    if cancel_flag["cancelled"]:
                        return False
                    # 使用 run_task 在主线程更新 UI
                    page.run_task(update_progress_async, status, progress)
                    return True
            def install():
                def update_progress(status: str, progress: float):
                    if cancel_flag["cancelled"]:
                        return False

                    async def update_ui():
                        status_text.value = status
                        progress_bar.value = progress
                        page.update()

                    page.run_task(update_ui)
                    return True

                # 检查是否已取消
                if not update_progress("正在克隆仓库...", 0.3):
                    page.run_task(close_dialog_async)
                    page.run_task(partial(show_snackbar_async, "安装已取消", ft.Colors.ORANGE_600))
                    return

                success, message = ext_manager.install_from_git(
                    url, ext_type, custom_name
                )

                # 检查是否已取消（安装完成后）
                if cancel_flag["cancelled"]:
                    page.run_task(close_dialog_async)
                    page.run_task(partial(show_snackbar_async, "安装已取消", ft.Colors.ORANGE_600))
                    return

                update_progress("安装完成" if success else "安装失败", 1.0)

                async def show_result_async():
                    close_dialog()
                    color = ft.Colors.GREEN_600 if success else ft.Colors.RED_600
                    show_snackbar(message, color)
                    if success:
                        refresh_lists()

                page.run_task(show_result_async)
                if not update_progress("正在克隆仓库...", 0.3):
                    page.run_task(close_dialog_async)
                    page.run_task(partial(show_snackbar_async, "安装已取消", ft.Colors.ORANGE_600))
                    return

                success, message = ext_manager.install_from_git(
                    url, ext_type, custom_name
                )

                # 检查是否已取消（安装完成后）
                if cancel_flag["cancelled"]:
                    page.run_task(close_dialog_async)
                    page.run_task(partial(show_snackbar_async, "安装已取消", ft.Colors.ORANGE_600))
                    return

                update_progress("安装完成" if success else "安装失败", 1.0)

                async def show_result():
                    close_dialog()
                    color = ft.Colors.GREEN_600 if success else ft.Colors.RED_600
                    show_snackbar(message, color)
                    if success:
                        refresh_lists()

                page.run_task(show_result)

            threading.Thread(target=install, daemon=True).start()

        def on_cancel(e):
            close_dialog()

        dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("从 Git 安装扩展"),
            content=ft.Column(
                [
                    ft.Text("支持 GitHub 仓库，自动使用设置的镜像源加速下载"),
                    url_field,
                    type_dropdown,
                ],
                tight=True,
                spacing=10,
            ),
            actions=[
                ft.TextButton("取消", on_click=on_cancel),
                ft.ElevatedButton("安装", on_click=on_confirm),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )

        show_dialog(dialog)

    def show_zip_install_dialog():
        """显示ZIP安装对话框（带取消功能）"""
        # 创建文件选择器（Service）
        file_picker = ft.FilePicker()
        path_field = ft.TextField(
            label="ZIP 文件路径",
            hint_text="请选择 ZIP 文件",
            prefix_icon=ft.Icons.FOLDER,
            read_only=True,
        )
        
        async def on_pick_file_click(e):
            """点击选择文件按钮"""
            files = await file_picker.pick_files(
                allow_multiple=False,
                file_type=ft.FilePickerFileType.CUSTOM,
                allowed_extensions=["zip"],
            )
            if files:
                # 获取选择的第一个文件
                selected_file = files[0]
                path_field.value = selected_file.path
                page.update()
        def on_confirm(e):
            zip_path = path_field.value.strip()
            if not zip_path:
                show_snackbar("请选择 ZIP 文件", ft.Colors.RED_600)
                return
            
            ext_type = (
                ExtensionType.GLOBAL
                if type_dropdown.value == "global"
                else ExtensionType.USER
            )
            custom_name = None

            close_dialog()

            # 创建进度对话框（带取消按钮）
            progress_bar = ft.ProgressBar(width=400, value=0)
            status_text = ft.Text("准备解压...", size=14)
            cancel_flag = {"cancelled": False}

            def on_cancel_install(e):
                cancel_flag["cancelled"] = True
                status_text.value = "正在取消..."
                page.update()

            progress_dialog = ft.AlertDialog(
                modal=True,
                title=ft.Text("正在安装扩展"),
                content=ft.Column(
                    [
                        ft.Text(f"从 ZIP 文件安装: {zip_path}"),
                        ft.Divider(),
                        status_text,
                        progress_bar,
                    ],
                    tight=True,
                    spacing=10,
                ),
                actions=[
                    ft.TextButton("取消", on_click=on_cancel_install),
                ],
                actions_alignment=ft.MainAxisAlignment.END,
            )
            show_dialog(progress_dialog)

            def install():
                async def update_progress_async(status: str, progress: float):
                    if cancel_flag["cancelled"]:
                        return False
                    status_text.value = status
                    progress_bar.value = progress
                    page.update()
                    return True
                
                def update_progress(status: str, progress: float):
                    if cancel_flag["cancelled"]:
                        return False
                    page.run_task(update_progress_async, status, progress)
                    return True
                
                # 检查是否已取消
                if not update_progress("正在解压文件...", 0.3):
                    page.run_task(close_dialog_async)
                    page.run_task(partial(show_snackbar_async, "安装已取消", ft.Colors.ORANGE_600))
                    return
                
                success, message = ext_manager.install_from_zip(
                    zip_path, ext_type, custom_name
                )
                
                # 检查是否已取消（安装完成后）
                if cancel_flag["cancelled"]:
                    page.run_task(close_dialog_async)
                    page.run_task(partial(show_snackbar_async, "安装已取消", ft.Colors.ORANGE_600))
                    return
                
                update_progress("安装完成" if success else "安装失败", 1.0)
                
                async def show_result_async():
                    close_dialog()
                    color = ft.Colors.GREEN_600 if success else ft.Colors.RED_600
                    show_snackbar(message, color)
                    if success:
                        refresh_lists()
                
                page.run_task(show_result_async)
            
            threading.Thread(target=install, daemon=True).start()

        def on_cancel(e):
            close_dialog()

        # 文件选择行
        file_pick_row = ft.Row(
            [
                path_field,
                ft.IconButton(
                    icon=ft.Icons.FOLDER_OPEN,
                    tooltip="选择文件",
                    on_click=on_pick_file_click,
                ),
            ],
            spacing=5,
        )
        
        type_dropdown = ft.Dropdown(
            label="安装到",
            value="global",
            options=[
                ft.dropdown.Option("global", "全局插件"),
                ft.dropdown.Option("user", "用户插件"),
            ],
        )
        
        def on_cancel(e):
            close_dialog()

        dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("从 ZIP 安装扩展"),
            content=ft.Column(
                [
                    ft.Text("请选择 ZIP 文件或输入文件路径"),
                    file_pick_row,
                    type_dropdown,
                ],
                tight=True,
                spacing=10,
            ),
            actions=[
                ft.TextButton("取消", on_click=on_cancel),
                ft.ElevatedButton("安装", on_click=on_confirm),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )

        show_dialog(dialog)

    # 刷新按钮
    refresh_btn = ft.IconButton(
        icon=ft.Icons.REFRESH, tooltip="刷新列表", on_click=lambda e: refresh_lists()
    )

    # 安装按钮
    install_git_btn = ft.ElevatedButton(
        "从Git安装",
        icon=ft.Icons.CLOUD_DOWNLOAD,
        on_click=lambda e: show_git_install_dialog(),
    )

    install_zip_btn = ft.ElevatedButton(
        "从ZIP安装",
        icon=ft.Icons.FOLDER_ZIP,
        on_click=lambda e: show_zip_install_dialog(),
    )

    # 顶部工具栏
    toolbar = ft.Row(
        [
            ft.Text("扩展管理", size=24, weight=ft.FontWeight.BOLD, expand=True),
            refresh_btn,
            install_git_btn,
            install_zip_btn,
        ],
        alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
    )

    # 创建全局插件内容
    global_content = ft.Column(
        [
            ft.Text(
                "全局插件对所有用户生效，路径: SillyTavern/public/scripts/extensions/third-party",
                size=12,
                color=ft.Colors.GREY_600,
                italic=True,
            ),
            ft.Divider(),
            global_list,
        ],
        expand=True,
    )

    # 创建用户插件内容
    user_content = ft.Column(
        [
            ft.Text(
                "用户插件仅对当前用户生效，路径: SillyTavern/data/default-user/extensions",
                size=12,
                color=ft.Colors.GREY_600,
                italic=True,
            ),
            ft.Divider(),
            user_list,
        ],
        expand=True,
    )

    # 使用 Flet 0.80+ 的 Tabs 结构
    tabs_control = ft.Tabs(
        selected_index=0,
        length=2,
        animation_duration=300,
        expand=True,
        content=ft.Column(
            [
                ft.TabBar(
                    tabs=[
                        ft.Tab(label="全局插件", icon=ft.Icons.PUBLIC),
                        ft.Tab(label="用户插件", icon=ft.Icons.PERSON),
                    ]
                ),
                ft.TabBarView(
                    controls=[global_content, user_content],
                    expand=True,
                ),
            ],
            expand=True,
        ),
    )

    # 主视图
    view = ft.Column([toolbar, ft.Divider(), tabs_control], expand=True, spacing=10)

    # 初始加载列表
    refresh_lists()

    return view
