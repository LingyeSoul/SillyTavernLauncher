/**
 * uiState store：当前视图 / toast 队列 / 对话框栈。
 * Toast 纪律（§5.11）：单例 + 队列 + 300ms 衔接闩锁、不自动消失（Forge timeout -1 原值）。
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
}

let nextToastId = 1
/** 退场 240ms + 空档 60ms = 300ms 衔接（M5）；reduced-motion 时立即结算 */
const TOAST_EXIT_MS = 240
const TOAST_GAP_MS = 60

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
      set({ toast: next, toastQueue: rest, toastClosing: false })
      return
    }
    set({ toastClosing: true })
    settle(() => {
      const state = get()
      if (state.toast?.id !== toast.id) return
      const [next, ...rest] = state.toastQueue
      if (next) set({ toast: next, toastQueue: rest, toastClosing: false })
      else set({ toast: null, toastClosing: false })
    })
  },

  dialogs: [],
  openDialog: (dialog) => set((s) => ({ dialogs: [...s.dialogs, dialog] })),
  closeTopDialog: () => set((s) => ({ dialogs: s.dialogs.slice(0, -1) })),
}))

/** 便捷引用（非 React 上下文内使用，如 store/service 回调） */
export const uiStateActions = {
  pushToast: (kind: ToastKind, message: string) => useUiState.getState().pushToast(kind, message),
  openDialog: (d: DialogDescriptor) => useUiState.getState().openDialog(d),
  closeTopDialog: () => useUiState.getState().closeTopDialog(),
}
