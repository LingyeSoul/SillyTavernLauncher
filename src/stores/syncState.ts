/**
 * syncState store：DataSyncManager 模块级单例 + 同步日志环形缓冲（zustand 绑定）。
 *
 * Bug#2 修复：原先 manager 与 AbortController 挂在 SyncView 组件 ref 上，
 * 视图卸载（切走再切回）即与运行中的服务器/同步任务失联——孤儿服务器占端口、
 * 同步不可取消、可并发双写。现提升为模块级单例（模式照 stState.getStLifecycle），
 * 日志回调写本 store，取消句柄存 manager（见 services/sync/manager cancelActiveSync）。
 */
import { join } from 'node:path'
import { create } from 'zustand'
import { DataSyncManager } from '../services/sync/manager'
import type { SyncLogLevel } from '../services/sync/server'

export interface SyncLogEntry {
  id: number
  message: string
  level: SyncLogLevel
}

export const SYNC_LOG_RING = 50

let nextLogId = 1

interface SyncStateState {
  logs: SyncLogEntry[]
  appendLog: (message: string, level?: SyncLogLevel) => void
}

export const useSyncState = create<SyncStateState>((set) => ({
  logs: [],
  appendLog: (message, level = 'info') =>
    set((s) => {
      const next = [...s.logs, { id: nextLogId++, message, level }]
      return {
        logs: next.length > SYNC_LOG_RING ? next.slice(next.length - SYNC_LOG_RING) : next,
      }
    }),
}))

/** 单例：日志回调写 syncState store（视图卸载不失联） */
let manager: DataSyncManager | null = null
export function getSyncManager(): DataSyncManager {
  if (!manager) {
    manager = new DataSyncManager({
      dataDir: join(process.cwd(), 'SillyTavern', 'data', 'default-user'),
      log: (message, level) => useSyncState.getState().appendLog(message, level),
    })
  }
  return manager
}
