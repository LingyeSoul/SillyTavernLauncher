/**
 * 托盘动作的 UI 层接线：把 stores / AppShell 的能力打包成 TrayHandlers 注入托盘服务。
 * 为什么长在 UI 层：分层约束是 services 不反向依赖 stores/UI（settings、stState
 * 均依赖 services，反向引用会造成环）；这束 handlers 是纯接线（无自有逻辑），
 * 由 app.tsx（启动初始化）与 SettingsView（开关热切换）共用——托盘动作语义只有
 * 这一处定义。
 */
import { destroyTray, initTray } from '../services/tray'
import { showMainWindow } from '../services/windowControl'
import { useStState } from '../stores/stState'
import { quitLauncher } from './shell/AppShell'
import { LOGO_DATA_URL } from './assets/logo'

/** 托盘动作束：语义与旧版 pystray 五项对齐（菜单模型见 services/tray.ts） */
export function buildTrayHandlers() {
  return {
    onOpenMain: () => showMainWindow(),
    isStRunning: () => useStState.getState().running,
    onStartSt: () => void useStState.getState().startSt(),
    onStopSt: () => void useStState.getState().stopSt(),
    // 重启 = 停了再起（stState 无 restartSt 动作；起停各取一次 getState 防闭包陈旧）
    onRestartSt: () => {
      void (async () => {
        const current = useStState.getState()
        if (current.running) await current.stopSt()
        await useStState.getState().startSt()
      })()
    },
    onQuit: () => void quitLauncher(),
  }
}

/**
 * 按开关状态启用/停用托盘（设置页切换与启动初始化共用同一入口；幂等——
 * initTray 对已启用只刷新 handlers，destroyTray 对未启用是空操作）。
 */
export async function applyTrayEnabled(enabled: boolean): Promise<boolean> {
  if (enabled) {
    return initTray({ iconDataUrl: LOGO_DATA_URL, handlers: buildTrayHandlers() })
  }
  destroyTray()
  return false
}
