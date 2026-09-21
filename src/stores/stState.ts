/**
 * stState store：ST 运行中/版本/忙碌状态 + StLifecycle 编排（视图不直接调 services，D2）。
 *
 * - lifecycle 实例的 onLog → terminalLogs（完整缓冲）。
 * - busy 标志驱动按钮禁用（硬性纪律：loading/busy 必须有 UI 反馈）。
 * - 运行状态派生自 processManager 活动进程计数（服务层 DEVIATION 已声明该等价）；
 *   AppShell 以 2s 轮询调 refresh() 保证进程退出后 UI 复位（GPUIX 无进程退出回调）。
 * - 操作级失败 → toast；意外异常 → toast + error 对话框（禁止静默失败）。
 */
import { join } from 'node:path'
import { create } from 'zustand'
import { StLifecycle } from '../services/stLifecycle'
import { checkStInstalled } from '../services/env'
import { errMsg, logError } from '../services/errorLog'
import { hasActiveProcess } from '../services/processManager'
import { getConfigStore, type EnvMode } from '../services/configStore'
import { useTerminalLogs } from './terminalLogs'
import { uiStateActions } from './uiState'

export interface StVersionInfo {
  /** 当前 checkout 的 tag（git describe --tags --abbrev=0），无 tag 时为 null */
  version: string | null
  commit: string | null
}

function appendLog(message: string): void {
  useTerminalLogs.getState().appendLine(message)
}

/** 单例：日志回调直接写 terminalLogs */
let lifecycle: StLifecycle | null = null
export function getStLifecycle(): StLifecycle {
  if (!lifecycle) {
    lifecycle = new StLifecycle({ onLog: appendLog })
  }
  return lifecycle
}

export function stDirPath(): string {
  return join(process.cwd(), 'SillyTavern')
}

interface StStateState {
  running: boolean
  installed: boolean
  busy: { install: boolean; start: boolean; stop: boolean; update: boolean }
  currentVersion: StVersionInfo | null
  versionLoading: boolean

  refresh: () => void
  refreshVersion: () => Promise<void>
  installSt: () => Promise<void>
  /** 启动（按 stcheckupdate 配置决定是否先检查更新，← Flet 启动按钮语义） */
  startSt: () => Promise<void>
  stopSt: () => Promise<void>
  updateSt: () => Promise<void>
}

export const useStState = create<StStateState>((set, get) => ({
  // running 只认 st-server（启动的 server.js 本体）；git/npm 等临时任务不算
  running: hasActiveProcess('st-server'),
  installed: checkStInstalled(stDirPath()),
  busy: { install: false, start: false, stop: false, update: false },
  currentVersion: null,
  versionLoading: false,

  refresh: () => {
    set({
      running: hasActiveProcess('st-server'),
      installed: checkStInstalled(stDirPath()),
    })
  },

  refreshVersion: async () => {
    set({ versionLoading: true })
    try {
      const dir = stDirPath()
      // Phase 4（设计 §8.2）：embedded 经进程内 Git 读当前版本（describe + HEAD 的
      // 等价实现）；其余模式与现状一致走 git.ts spawn（命令零变化，D3）
      const envMode = getConfigStore().get<EnvMode>('env_mode', 'portable')
      if (envMode === 'embedded') {
        const { currentVersionEmbedded } = await import('../services/isoGit')
        set({ currentVersion: await currentVersionEmbedded(dir) })
        return
      }
      const { getCurrentCommit, runGit } = await import('../services/git')
      const describe = await runGit(['describe', '--tags', '--abbrev=0'], dir)
      const commitResult = await getCurrentCommit(dir)
      set({
        currentVersion: {
          version: describe.ok ? describe.stdout.trim() || null : null,
          commit: commitResult.ok ? commitResult.commit : null,
        },
      })
    } catch (err) {
      logError(`[stState] 读取当前版本失败: ${errMsg(err)}`)
      set({ currentVersion: null })
    } finally {
      set({ versionLoading: false })
    }
  },

  installSt: async () => {
    // 跨操作互斥（2026-09-21 真机竞态：安装中点启动 → 半成品依赖直接崩）：
    // 安装/启动/更新三者共享 ST 目录与 node_modules，任一进行中不接受新操作。
    const busy = get().busy
    if (busy.install || busy.start || busy.update) {
      appendLog('已有安装/启动/更新操作进行中，已忽略本次安装请求')
      return
    }
    set((s) => ({ busy: { ...s.busy, install: true } }))
    try {
      const result = await getStLifecycle().installSt()
      if (!result.ok) uiStateActions.pushToast('error', result.message)
      get().refresh()
    } catch (err) {
      reportUnexpected('安装 SillyTavern', err)
    } finally {
      set((s) => ({ busy: { ...s.busy, install: false } }))
    }
  },

  startSt: async () => {
    const busy = get().busy
    if (busy.start || busy.install || busy.update) {
      appendLog('已有安装/启动/更新操作进行中，已忽略本次启动请求')
      return
    }
    set((s) => ({ busy: { ...s.busy, start: true } }))
    try {
      const config = getConfigStore()
      const lc = getStLifecycle()
      // ← Flet：stcheckupdate 开 → check_and_start（先检查更新），否则直接启动
      const result = config.get<boolean>('stcheckupdate', true)
        ? await lc.checkAndStartSt()
        : await lc.startSt()
      if (!result.ok) {
        // 已在运行/未安装/依赖缺失等业务失败：日志已有，toast 提醒
        uiStateActions.pushToast('warning', result.message)
      }
      get().refresh()
    } catch (err) {
      reportUnexpected('启动 SillyTavern', err)
    } finally {
      set((s) => ({ busy: { ...s.busy, start: false } }))
      get().refresh()
    }
  },

  stopSt: async () => {
    if (get().busy.stop) return
    set((s) => ({ busy: { ...s.busy, stop: true } }))
    try {
      const result = await getStLifecycle().stopSt()
      if (!result.ok) uiStateActions.pushToast('error', result.message)
      get().refresh()
    } catch (err) {
      reportUnexpected('停止 SillyTavern', err)
    } finally {
      set((s) => ({ busy: { ...s.busy, stop: false } }))
      get().refresh()
    }
  },

  updateSt: async () => {
    const busy = get().busy
    if (busy.update || busy.install || busy.start) {
      appendLog('已有安装/启动/更新操作进行中，已忽略本次更新请求')
      return
    }
    set((s) => ({ busy: { ...s.busy, update: true } }))
    try {
      const result = await getStLifecycle().updateSt()
      if (result.ok) uiStateActions.pushToast('success', '更新完成')
      else uiStateActions.pushToast('error', result.message)
      get().refresh()
    } catch (err) {
      reportUnexpected('更新 SillyTavern', err)
    } finally {
      set((s) => ({ busy: { ...s.busy, update: false } }))
      get().refresh()
    }
  },
}))

function reportUnexpected(where: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  logError(`[stState] ${where} 意外错误: ${message}`)
  uiStateActions.pushToast('error', `${where} 时发生意外错误`)
  uiStateActions.openDialog({
    kind: 'error',
    title: '发生错误',
    message: `${where} 时发生意外错误`,
    detail: message,
  })
}
