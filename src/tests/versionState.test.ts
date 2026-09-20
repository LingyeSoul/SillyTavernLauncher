/**
 * versionState store 层：版本列表暂存语义（2026-09-20 切页免重载）。
 * - ensureVersions 命中缓存/加载中不重复拉取（切页重挂场景）；
 * - reloadVersions 强制重拉（手动刷新按钮）；
 * - 业务失败 → error + 空列表；实际发起加载才打终端日志（缓存命中不污染终端）。
 * 纯 store 测试不挂 GPU 渲染；getStTags mock 掉（不跑真实 git）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TagsResult } from '../services/types'

const { getStTagsMock } = vi.hoisted(() => ({ getStTagsMock: vi.fn() }))
vi.mock('../services/git', () => ({ getStTags: getStTagsMock }))

interface VersionStateModule {
  useVersionState: {
    getState: () => {
      versions: Array<{ version: string; tag: { commit: string; date: string; tag_name: string } }> | null
      loading: boolean
      error: string | null
      ensureVersions: () => Promise<void>
      reloadVersions: () => Promise<void>
    }
  }
}

/** fresh module：vi.resetModules 重建 versionState 单例（各用例互不串缓存） */
async function freshStore(): Promise<VersionStateModule> {
  vi.resetModules()
  return (await import('../stores/versionState')) as unknown as VersionStateModule
}

/** 两版本假数据（乱序输入 → 断言按语义化版本降序） */
function tagsResult(): TagsResult {
  return {
    ok: true,
    message: '',
    data: {
      latest: '1.13.0',
      versions: {
        '1.12.0': { commit: 'a'.repeat(40), date: '2025-01-01T00:00:00Z', tag_name: 'v1.12.0' },
        '1.13.0': { commit: 'b'.repeat(40), date: '2025-02-01T00:00:00Z', tag_name: 'v1.13.0' },
      },
    },
  }
}

beforeEach(() => {
  getStTagsMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('版本列表暂存', () => {
  it('首次 ensureVersions 拉取并缓存，按版本降序排序', async () => {
    getStTagsMock.mockResolvedValue(tagsResult())
    const { useVersionState } = await freshStore()

    await useVersionState.getState().ensureVersions()

    expect(getStTagsMock).toHaveBeenCalledTimes(1)
    const s = useVersionState.getState()
    expect(s.loading).toBe(false)
    expect(s.error).toBeNull()
    expect(s.versions?.map((e) => e.version)).toEqual(['1.13.0', '1.12.0'])
  })

  it('命中缓存时切页重挂（再次 ensureVersions）不重新拉取、不打终端日志', async () => {
    getStTagsMock.mockResolvedValue(tagsResult())
    const { useVersionState } = await freshStore()
    await useVersionState.getState().ensureVersions()
    expect(getStTagsMock).toHaveBeenCalledTimes(1)

    const { useTerminalLogs } = await import('../stores/terminalLogs')
    const linesBefore = useTerminalLogs.getState().lines.length

    // 模拟切走再切回：视图重挂 → ensureVersions 应直接命中缓存
    await useVersionState.getState().ensureVersions()

    expect(getStTagsMock).toHaveBeenCalledTimes(1)
    expect(useVersionState.getState().versions?.map((e) => e.version)).toEqual(['1.13.0', '1.12.0'])
    expect(useTerminalLogs.getState().lines.length).toBe(linesBefore)
  })

  it('reloadVersions 强制重拉（手动刷新按钮语义）', async () => {
    getStTagsMock.mockResolvedValue(tagsResult())
    const { useVersionState } = await freshStore()
    await useVersionState.getState().ensureVersions()

    await useVersionState.getState().reloadVersions()

    expect(getStTagsMock).toHaveBeenCalledTimes(2)
    expect(useVersionState.getState().versions?.length).toBe(2)
  })

  it('加载中防重入：并发 ensure/reload 只拉一次', async () => {
    let release: (() => void) | undefined
    getStTagsMock.mockImplementation(
      () =>
        new Promise<TagsResult>((resolve) => {
          release = () => resolve(tagsResult())
        }),
    )
    const { useVersionState } = await freshStore()

    const first = useVersionState.getState().ensureVersions()
    const second = useVersionState.getState().reloadVersions()
    await second
    release?.()
    await first

    expect(getStTagsMock).toHaveBeenCalledTimes(1)
    expect(useVersionState.getState().versions?.length).toBe(2)
  })

  it('业务失败：error 置位、列表为空、不再命中缓存', async () => {
    getStTagsMock.mockResolvedValue({ ok: false, data: null, message: 'SillyTavern目录不存在' })
    const { useVersionState } = await freshStore()

    await useVersionState.getState().ensureVersions()

    const s = useVersionState.getState()
    expect(s.error).toBe('SillyTavern目录不存在')
    expect(s.versions).toEqual([])
    expect(s.loading).toBe(false)

    // 失败态（versions=[] 非 null）同样视为已有数据，重挂不自动重试；
    // 用户经刷新按钮（reloadVersions）显式重试
    await useVersionState.getState().ensureVersions()
    expect(getStTagsMock).toHaveBeenCalledTimes(1)
  })
})
