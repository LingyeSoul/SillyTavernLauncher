/**
 * uiState store：当前视图 / toast 队列 / 对话框栈。
 * Toast 纪律（§5.11）：单例 + 队列 + 300ms 衔接闩锁。
 * DEVIATION: toast 自动关闭（按语义分级驻留，见 TOAST_AUTO_MS）——设计 §5.11 原值
 * timeout -1 仅手动关，用户反馈 toast 不自动消失是缺陷。error 级驻留最长且保留手动 X，
 * 重大错误另有 ErrorDialog + errorLog 兜底，自动关闭不丢反馈。
 */
import { create } from 'zustand'
import { getConfigStore } from '../services/configStore'
import type { ExtensionInfo } from '../services/extensions'

export type ViewId = 'terminal' | 'version' | 'sync' | 'extensions' | 'settings' | 'about'

export const VIEW_IDS: readonly ViewId[] = [
  'terminal', 'version', 'sync', 'extensions', 'settings', 'about',
]

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

/** 对话框描述（discriminated union；DialogHost 按 kind 渲染） */
export type DialogDescriptor =
  | { kind: 'eula' }
  | { kind: 'welcome' }
  | { kind: 'ipWhitelist' }
  | { kind: 'hostWhitelist' }
  | { kind: 'privateRanges' }
  | {
      kind: 'ageConfirm'
      mode: 'install' | 'start'
      onConfirm: (ok: boolean) => void
    }
  | {
      kind: 'updateAvailable'
      currentVersion: string
      latestVersion: string
      changelog: string | null
      downloadUrl: string
    }
  | { kind: 'error'; title: string; message: string; detail?: string }
  | { kind: 'exitConfirm'; onConfirm: () => void }
  | {
      kind: 'versionSwitch'
      version: string
      commit: string
      date: string
      tagName: string
    }
  | { kind: 'gitInstall' }
  | { kind: 'zipInstall' }
  | { kind: 'deleteExtension'; ext: ExtensionInfo }

interface UiState {
  view: ViewId
  setView: (view: ViewId) => void

  /** 当前展示的 toast（队列头）；null = 无 */
  toast: ToastItem | null
  toastQueue: ToastItem[]
  toastClosing: boolean
  pushToast: (kind: ToastKind, message: string) => void
  dismissToast: () => void

  dialogs: DialogDescriptor[]
  openDialog: (dialog: DialogDescriptor) => void
  closeTopDialog: () => void

  /** 扩展列表变更计数（安装/删除/移动后 bump，驱动 ExtensionsView 重扫） */
  extensionsVersion: number
  bumpExtensions: () => void
}

let nextToastId = 1
/** 退场 240ms + 空档 60ms = 300ms 衔接（M5）；reduced-motion 时立即结算 */
const TOAST_EXIT_MS = 240
const TOAST_GAP_MS = 60
/**
 * 各语义级自动关闭驻留时长（ms）。注意：这是业务驻留时长，不随 reduced-motion
 * 归零（动画时长归零，信息该让人看到多久还是多久）。
 */
export const TOAST_AUTO_MS: Record<ToastKind, number> = {
  info: 4000,
  success: 4000,
  warning: 6000,
  error: 8000,
}

/** 当前自动退场定时器（模块级单例，与 toast 单例展示一一对应） */
let autoDismissTimer: ReturnType<typeof setTimeout> | null = null

function clearAutoDismiss(): void {
  if (autoDismissTimer !== null) {
    clearTimeout(autoDismissTimer)
    autoDismissTimer = null
  }
}

/** toast 开始展示时排自动退场；到期统一走 dismissToast（复用 300ms 衔接闩锁推进队列） */
function scheduleAutoDismiss(item: ToastItem): void {
  clearAutoDismiss()
  autoDismissTimer = setTimeout(() => {
    autoDismissTimer = null
    // id 守卫：期间若已被手动关闭/换条/测试直写 state 清空，不得误伤当前展示
    const s = useUiState.getState()
    if (s.toast?.id === item.id && !s.toastClosing) s.dismissToast()
  }, TOAST_AUTO_MS[item.kind])
}

export const useUiState = create<UiState>((set, get) => ({
  view: 'terminal',
  setView: (view) => set({ view }),

  toast: null,
  toastQueue: [],
  toastClosing: false,

  pushToast: (kind, message) => {
    const item: ToastItem = { id: nextToastId++, kind, message }
    const { toast, toastQueue } = get()
    if (toast === null) {
      set({ toast: item, toastQueue, toastClosing: false })
      scheduleAutoDismiss(item)
      return
    }
    // 队列上限（防错误风暴无限堆积；丢最老的，保留最新）
    const capped =
      toastQueue.length >= 30 ? [...toastQueue.slice(1), item] : [...toastQueue, item]
    set({ toastQueue: capped })
  },

  dismissToast: () => {
    const { toast, toastQueue, toastClosing } = get()
    if (toast === null || toastClosing) return
    // 手动关闭后自动退场定时器作废（推进展示下一条时会重新排）
    clearAutoDismiss()
    // §6.B：reduced-motion 时长归零但回调照常——立即结算
    const motionEnabled = getConfigStore().get<boolean>('motionEnabled', true)
    const settle = (fn: () => void): void => {
      if (motionEnabled) setTimeout(fn, TOAST_EXIT_MS + TOAST_GAP_MS)
      else fn()
    }
    if (toastQueue.length === 0) {
      if (!motionEnabled) {
        set({ toast: null, toastClosing: false })
        return
      }
      set({ toastClosing: true })
      setTimeout(() => {
        if (get().toast?.id === toast.id) set({ toast: null, toastClosing: false })
      }, TOAST_EXIT_MS)
      return
    }
    // 有后续：退场 240ms + 空档 60ms 后展示下一条（300ms 衔接闩锁）
    if (!motionEnabled) {
      const [next, ...rest] = toastQueue
      if (next) scheduleAutoDismiss(next)
      set({ toast: next, toastQueue: rest, toastClosing: false })
      return
    }
    set({ toastClosing: true })
    settle(() => {
      const state = get()
      if (state.toast?.id !== toast.id) return
      const [next, ...rest] = state.toastQueue
      if (next) {
        scheduleAutoDismiss(next)
        set({ toast: next, toastQueue: rest, toastClosing: false })
      } else {
        set({ toast: null, toastClosing: false })
      }
    })
  },

  dialogs: [],
  openDialog: (dialog) => set((s) => ({ dialogs: [...s.dialogs, dialog] })),
  closeTopDialog: () => set((s) => ({ dialogs: s.dialogs.slice(0, -1) })),

  extensionsVersion: 0,
  bumpExtensions: () => set((s) => ({ extensionsVersion: s.extensionsVersion + 1 })),
}))

/** 便捷引用（非 React 上下文内使用，如 store/service 回调） */
export const uiStateActions = {
  pushToast: (kind: ToastKind, message: string) => useUiState.getState().pushToast(kind, message),
  openDialog: (d: DialogDescriptor) => useUiState.getState().openDialog(d),
  closeTopDialog: () => useUiState.getState().closeTopDialog(),
  bumpExtensions: () => useUiState.getState().bumpExtensions(),
}
