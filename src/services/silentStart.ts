/**
 * 静默启动判定（config.autostart_hidden，2026-09-22）：自动启动 + 静默开关 +
 * 托盘三键齐开、且本轮启动无交互步骤（非首跑、EULA 已过）时，建窗后将主窗口
 * 隐藏到托盘、从托盘菜单唤回——旧 Python 版"开机静默启动 + 隐藏窗口"语义的
 * 可选恢复（D1 迁移曾整体改为窗口正常显示，现按用户选择切回）。
 *
 * 安全前提有两层，缺一不可：
 * 1. 调用点（app.tsx）只在托盘真实挂载成功（applyTrayEnabled 返回 true）后才
 *    执行隐藏——initTray 失败时藏窗 = 无托盘图标、任务栏无窗口，用户失去唯一
 *    唤回入口，宁可窗口照常显示。
 * 2. 本判定自查 tray 配置键（双保险，防手改 config.json 凑出"静默开但托盘关"
 *    的组合）与交互前提（首跑向导 / EULA 弹窗需要可见窗口才能完成）。
 */
import type { ConfigStore } from './configStore'
import { eulaDialogRequired } from './agreement'

export function shouldHideAtStartup(config: ConfigStore): boolean {
  if (!config.get<boolean>('autostart', false)) return false
  if (!config.get<boolean>('autostart_hidden', false)) return false
  if (!config.get<boolean>('tray', false)) return false
  if (config.get<boolean>('first_run', true)) return false
  if (eulaDialogRequired(config)) return false
  return true
}
