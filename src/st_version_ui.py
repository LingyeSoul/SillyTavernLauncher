"""
SillyTavern版本切换UI组件
"""
import flet as ft
from st_version_manager import STVersionManager
from git_utils import get_current_commit


def create_version_card(version_str, version_data, is_current=False, on_click=None):
    """
    创建单个版本卡片

    Args:
        version_str (str): 版本号
        version_data (dict): {commit, date, source}
        is_current (bool): 是否为当前版本
        on_click (function): 点击事件处理函数

    Returns:
        ft.Container: 版本卡片控件
    """
    manager = STVersionManager()
    formatted_date = manager.format_version_date(version_data['date'])

    # 当前版本标识
    current_badge = ft.Container(
        content=ft.Text("当前", size=11, color=ft.Colors.WHITE),
        bgcolor=ft.Colors.BLUE,
        padding=ft.padding.symmetric(horizontal=6, vertical=2),
        border_radius=4,
        visible=is_current,
    )

    # 根据是否为当前版本设置不同的文字颜色
    version_color = ft.Colors.BLUE if is_current else None
    date_color = ft.Colors.BLUE_GREY_700 if is_current else None
    commit_color = ft.Colors.BLUE_GREY_600 if is_current else None

    # 卡片内容 - 无背景色设计
    card = ft.Container(
        content=ft.Row([
            ft.Column([
                ft.Text(
                    f"v{version_str}",
                    size=16,
                    weight=ft.FontWeight.BOLD,
                    color=version_color
                ),
                ft.Text(
                    formatted_date,
                    size=12,
                    color=date_color
                ),
            ], spacing=2),
            ft.Column([
                ft.Text(
                    version_data['commit'][:7],
                    size=11,
                    color=commit_color,
                    font_family="Courier"
                ),
                current_badge,
            ], spacing=5, horizontal_alignment=ft.CrossAxisAlignment.END),
        ], alignment=ft.MainAxisAlignment.SPACE_BETWEEN, expand=True),
        padding=12,
        bgcolor=None,
        border=ft.border.all(1, ft.Colors.BLUE if is_current else ft.Colors.GREY_300),
        border_radius=8,
        on_click=on_click,
        ink=True,
    )

    return card


def show_version_switch_dialog(page, version_str, version_data, on_confirm):
    """
    显示版本切换确认对话框

    Args:
        page: Flet页面对象
        version_str (str): 版本号
        version_data (dict): 版本数据 {commit, date, source}
        on_confirm (function): 确认后的回调函数
    """
    manager = STVersionManager()
    formatted_date = manager.format_version_date(version_data['date'])

    dialog = ft.AlertDialog(
        modal=True,
        title=ft.Text("确认切换版本", size=18),
        content=ft.Column([
            ft.Text(f"版本: {version_str}", size=16, weight=ft.FontWeight.BOLD),
            ft.Text(f"日期: {formatted_date}", size=13, color=ft.Colors.GREY_600),
            ft.Text(f"Commit: {version_data['commit'][:7]}", size=13, color=ft.Colors.GREY_600),
            ft.Divider(height=20, color=ft.Colors.GREY_300),
            ft.Text(
                "注意：切换版本可能会导致一些问题，请注意备份数据！",
                size=13,
                color=ft.Colors.RED_600
            ),
        ], spacing=8, tight=True),
        actions=[
            ft.TextButton(
                "取消",
                on_click=lambda e: _close_dialog(page, dialog)
            ),
            ft.ElevatedButton(
                "确认",
                on_click=lambda e: do_switch(),
            ),
        ],
        actions_alignment=ft.MainAxisAlignment.END,
    )

    def do_switch():
        _close_dialog(page, dialog)
        on_confirm()

    # 使用 overlay 显示对话框（适配 Flet 0.80.1）
    page.overlay.append(dialog)
    dialog.open = True
    page.update()


def _close_dialog(page, dialog):
    """正确关闭对话框的辅助方法（适配 Flet 0.80.1）"""
    dialog.open = False
    page.update()
    if dialog in page.overlay:
        page.overlay.remove(dialog)
        page.update()


def create_version_switch_view(page, terminal, ui_event):
    """
    创建版本切换页面视图

    Args:
        page: Flet页面对象
        terminal: 终端对象（用于日志输出）
        ui_event: UiEvent对象（事件处理）

    Returns:
        ft.Column: 版本切换视图
    """
    manager = STVersionManager()

    # 当前版本显示
    current_version_text = ft.Text("正在获取...", size=18, weight=ft.FontWeight.BOLD)
    current_commit_text = ft.Text("", size=12, color=ft.Colors.GREY_600)

    # 版本列表容器
    versions_list = ft.Column([], spacing=8, scroll=ft.ScrollMode.AUTO, expand=True)

    # 加载指示器
    loading_indicator = ft.Column([
        ft.Text("正在加载版本列表...", size=14, color=ft.Colors.GREY_600),
        ft.ProgressBar(visible=True, width=200)
    ], horizontal_alignment=ft.CrossAxisAlignment.CENTER)

    # 错误提示
    error_text = ft.Text("", size=13, color=ft.Colors.RED, visible=False)

    # 获取当前版本
    def update_current_version():
        result = manager.get_current_version()
        if result['success']:
            current_version_text.value = result['version']
            # 获取当前commit
            success, commit, msg = get_current_commit()
            if success:
                current_commit_text.value = f"Commit: {commit[:7]}"
            else:
                current_commit_text.value = ""
        else:
            current_version_text.value = "未安装"
            current_commit_text.value = result['error']
        page.update()

    # 加载版本列表
    def load_versions():
        # 显示加载中
        versions_list.controls.clear()
        versions_list.controls.append(loading_indicator)
        error_text.visible = False
        page.update()

        # 获取版本列表
        result = manager.run_fetch_async()

        # 清除加载指示器
        versions_list.controls.clear()

        if not result['success']:
            # 显示错误
            error_text.value = f"获取版本列表失败: {result['error']}"
            error_text.visible = True
            versions_list.controls.append(
                ft.Text("暂无可选版本", size=14, color=ft.Colors.GREY_500)
            )
        else:
            # 获取当前版本信息
            current_version_result = manager.get_current_version()
            current_version = current_version_result.get('version', 'unknown')

            # 显示版本列表
            versions = result['versions']
            version_items = sorted(
                versions.items(),
                key=lambda x: x[0],
                reverse=True
            )

            if not version_items:
                versions_list.controls.append(
                    ft.Text("暂无可选版本", size=14, color=ft.Colors.GREY_500)
                )
            else:
                for version_str, version_data in version_items:
                    is_current = (version_str == current_version)
                    version_card = create_version_card(
                        version_str,
                        version_data,
                        is_current=is_current,
                        on_click=None if is_current else lambda e, v=version_str, d=version_data, c=version_data['commit']: show_switch_confirm(v, d)
                    )
                    versions_list.controls.append(version_card)

        page.update()

    # 刷新所有信息
    def refresh_all():
        """刷新当前版本和版本列表"""
        terminal.add_log("正在刷新版本信息...")
        update_current_version()
        load_versions()

    # 显示切换确认对话框
    def show_switch_confirm(version_str, version_data):
        def do_switch():
            # 将版本号添加到version_data中，方便event.py使用
            version_data_with_num = version_data.copy()
            version_data_with_num['version'] = version_str
            ui_event.switch_st_version(version_data_with_num, version_data['commit'])

        show_version_switch_dialog(page, version_str, version_data, do_switch)

    # 刷新按钮事件
    def on_refresh(e):
        terminal.add_log("正在刷新版本列表...")
        load_versions()

    # 主视图 - 简洁布局
    view = ft.Column([
        # 标题栏
        ft.Row([
            ft.Text("版本管理", size=24, weight=ft.FontWeight.BOLD, expand=True),
            ft.IconButton(
                icon=ft.Icons.REFRESH,
                icon_size=20,
                tooltip="刷新版本列表",
                on_click=on_refresh
            ),
        ]),

        ft.Divider(),

        # 当前版本信息
        ft.Container(
            content=ft.Row([
                ft.Column([
                    ft.Text("当前版本", size=15),
                    current_version_text,
                ], spacing=2, expand=True),
                ft.Column([
                    current_commit_text,
                ], horizontal_alignment=ft.CrossAxisAlignment.END),
            ], expand=True),
            padding=ft.padding.symmetric(horizontal=10, vertical=12),
            border_radius=8,
        ),

        # 错误提示
        error_text,

        # 版本列表标题
        ft.Text("可选版本（点击切换）", size=14),

        # 版本列表
        versions_list,

    ], spacing=12, expand=True)

    # 初始化时加载当前版本和版本列表
    update_current_version()
    load_versions()

    # 将刷新方法附加到视图对象上，方便外部调用
    view.refresh = refresh_all

    return view
