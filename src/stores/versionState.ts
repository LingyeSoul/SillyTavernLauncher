/**
 * versionState store：版本管理页版本列表暂存（2026-09-20）。
 * - 版本列表/加载/错误状态提升到全局 store：视图切页卸载不丢缓存，切回
 *   直接渲染已暂存数据，不再重走骨架动画与重复 git 扫描（用户痛点）。
 * - ensureVersions：视图挂载时消费——有缓存或加载中直接返回（防重入）；
 *   reloadVersions：手动刷新按钮——强制重拉（用户主动行为，走动画合理）。
 * - "正在刷新版本信息"终端日志仅在实际发起加载时打：切回页命中缓存不污染终端。
 * - 当前版本信息（currentVersion）属 stState，不在此暂存；视图挂载时静默
 *   refreshVersion 保证「当前」芯片在终端页更新/切版本后仍准确。
 */
import { create } from 'zustand'
import { compareVersions } from '../services/env'
import { getStTags } from '../services/git'
import type { GitTag } from '../services/types'
import { errMsg, logError } from '../services/errorLog'
import { useTerminalLogs } from './terminalLogs'

const REFRESHING_LOG = '正在刷新版本信息...'

export interface VersionEntry {
  version: string
  tag: GitTag
}

interface VersionStateState {
  /** 版本列表缓存；null = 从未加载完成过（与「加载过但为空/失败」的 [] 区分） */
  versions: VersionEntry[] | null
  loading: boolean
  error: string | null
  /** 视图挂载时确保有数据：命中缓存/加载中直接返回 */
  ensureVersions: () => Promise<void>
  /** 强制重拉（刷新按钮；加载中防重入） */
  reloadVersions: () => Promise<void>
}

async function fetchAndStore(set: (partial: Partial<VersionStateState>) => void): Promise<void> {
  set({ loading: true, error: null })
  useTerminalLogs.getState().appendLine(REFRESHING_LOG)
  try {
    const result = await getStTags()
    if (!result.ok || !result.data) {
      set({ error: result.message, versions: [] })
      return
    }
    const entries = Object.entries(result.data.versions)
      .map(([version, tag]) => ({ version, tag }))
      .sort((a, b) => compareVersions(b.version, a.version))
    set({ versions: entries })
  } catch (err) {
    const message = errMsg(err)
    logError(`[versionState] 获取版本列表失败: ${message}`)
    set({ error: message, versions: [] })
  } finally {
    set({ loading: false })
  }
}

export const useVersionState = create<VersionStateState>((set, get) => ({
  versions: null,
  loading: false,
  error: null,

  ensureVersions: async () => {
    if (get().loading || get().versions !== null) return
    await fetchAndStore(set)
  },

  reloadVersions: async () => {
    if (get().loading) return
    await fetchAndStore(set)
  },
}))
